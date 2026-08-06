#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chamadoDireto } from './executavel.js';
import { carregarAmbiente } from './ambiente.js';
import {
  PASTA_CERTIFICADOS_PADRAO,
  carregarConfig,
  configAvulsa,
  credenciaisDoAmbiente,
} from './config.js';
import { listarCertificados } from './certificados.js';
import { escolherCertificado, gravarVinculo, lerVinculos } from './vinculos.js';
import { limpar } from './documentos.js';
import { descreverSituacao } from './catalogo.js';
import { executar, planejar } from './executor.js';
import { gerarHtml } from './relatorio.js';
import { carregarAnterior, compararComAnterior, escreverIndice } from './historico.js';
import { cadeiaDe, rotear } from './provedores/index.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function lerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const chave = argv[i].slice(2);
    const valor = argv[i + 1]?.startsWith('--') ? true : argv[i + 1];
    args[chave] = valor ?? true;
    if (valor !== true) i += 1;
  }
  return args;
}

function competenciaAtual(agora = new Date()) {
  return `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Rotulo do relatorio de uma consulta avulsa.
 *
 * Nao usa a competencia do mes: sobrescreveria o acompanhamento da carteira
 * com o resultado de um documento so. O nome carrega o documento e a data.
 */
export function rotuloAvulso(documento, agora = new Date()) {
  const dia = agora.toISOString().slice(0, 10);
  return `avulso-${limpar(documento)}-${dia}`;
}

/**
 * Anexa ao cliente avulso o certificado da pasta, quando houver.
 *
 * Sem isso, CADIN e Situacao Fiscal voltam "sem certificado no cadastro" mesmo
 * com o `.pfx` ali do lado -- que foi exatamente o que aconteceu.
 */
async function anexarCertificado(config, documento, escolhaDoOperador = null) {
  const { arquivos } = await listarCertificados(config.certificados?.pastaPadrao);

  // A escolha explicita vence o palpite pelo nome, e fica guardada: o operador
  // so precisa apontar o arquivo de cada cliente uma vez.
  const arquivo = arquivos.includes(escolhaDoOperador)
    ? escolhaDoOperador
    : escolherCertificado(arquivos, documento, await lerVinculos());

  if (!arquivo) return;
  if (escolhaDoOperador === arquivo) await gravarVinculo(documento, arquivo);

  config.clientes[0].certificado = { arquivo, senhaVariavel: `CERT_${limpar(documento)}` };
}

export async function principal(argv = process.argv.slice(2), env = process.env) {
  const args = lerArgumentos(argv);

  // Senhas dos certificados. Vem antes de tudo porque a rodada pode ser
  // disparada pelo painel, que nao tem o ambiente do terminal do operador.
  if (env === process.env) carregarAmbiente(env);

  if (args.ajuda || args.help) {
    console.log(`
cnd-monitor — consulta mensal de certidões da carteira de clientes

  --documento <CNPJ>       consulta avulsa de um documento, sem cadastro
  --certidoes <a,b,c>      quais certidões na consulta avulsa
  --certificado <arquivo>  qual .pfx usar (fica lembrado para este documento)
  --municipio <nome>       exigido pela CND Municipal
  --clientes <arquivo>     padrão: clientes.json
  --provedor <id>          sobrescreve o provedorPadrao
                           (web | ecac | mock | infosimples | serpro)
  --competencia <AAAA-MM>  padrão: mês corrente
  --saida <pasta>          padrão: raiz do cnd-monitor
  --concorrencia <n>       consultas simultâneas (padrão 4)
  --simular                mostra o que seria consultado, sem tocar na rede
`);
    return 0;
  }

  const caminhoClientes = resolve(RAIZ, args.clientes ?? 'clientes.json');
  const pastaSaida = resolve(RAIZ, args.saida ?? '.');

  // Consulta avulsa: um documento, sem cadastro. Roda pelo mesmo caminho da
  // rodada mensal de propósito -- é assim que ela ganha o progresso ao vivo no
  // painel e o relatório no fim, em vez de ser uma chamada muda que devolve
  // uma tabela e não guarda nada.
  const avulso = Boolean(args.documento);
  const competencia = args.competencia ?? (avulso ? rotuloAvulso(args.documento) : competenciaAtual());

  const config = avulso
    ? configAvulsa({
        documento: String(args.documento),
        certidoes: args.certidoes ? String(args.certidoes).split(',') : null,
        provedor: args.provedor ?? 'auto',
        municipio: args.municipio ? String(args.municipio) : null,
        certificados: { pastaPadrao: PASTA_CERTIFICADOS_PADRAO },
      })
    : await carregarConfig(caminhoClientes);

  if (avulso) {
    await anexarCertificado(
      config,
      String(args.documento),
      args.certificado ? String(args.certificado) : null,
    );
  }
  const cadeia = args.provedor ? cadeiaDe(String(args.provedor)) : null;
  if (cadeia) {
    // Cada certidao vai ao provedor que a atende. Sem isso, escolher "ecac"
    // marcava como manual as cinco certidoes que ele nao cobre.
    config.provedorPadrao = cadeia[cadeia.length - 1];
    config.provedores = rotear(config.certidoesAtivas, cadeia);
  } else if (args.provedor) {
    // Forcar um provedor na linha de comando vale para tudo: os overrides por
    // certidao do arquivo nao podem sobreviver a um "--provedor web".
    config.provedorPadrao = args.provedor;
    config.provedores = {};
  }

  if (args.simular) {
    const plano = planejar(config);
    console.log(`\nPlano da competência ${competencia} — ${plano.total} consultas:`);
    for (const [provedor, quantas] of Object.entries(plano.porProvedor)) {
      console.log(`  ${provedor.padEnd(12)} ${quantas}`);
    }
    console.log(`\nCobradas por consulta: ${plano.cobraveis}`);
    if (config.limiteConsultas !== null) {
      console.log(`Limite configurado: ${config.limiteConsultas}`);
    }
    for (const aviso of config.avisos) console.warn(`Aviso: ${aviso}`);
    return 0;
  }

  // Agendamento rodando em simulado geraria, todo mês, um relatório de dados
  // inventados — e o commitaria no repositório. Rotulado, mas a um clique de
  // ser lido como situação real dos clientes.
  const simulado = new Set(
    config.certidoesAtivas.map((id) => config.provedores[id] ?? config.provedorPadrao),
  );
  if ((env.CI === 'true' || env.GITHUB_ACTIONS) && simulado.size === 1 && simulado.has('mock')) {
    console.error(
      'Erro: o agendamento está configurado com o provedor "mock" e produziria um relatório\n' +
        'de dados simulados. Configure um provedor real em clientes.json, ou desative o\n' +
        'agendamento até haver um. Para ignorar propositalmente: PERMITIR_MOCK_EM_CI=true.',
    );
    if (env.PERMITIR_MOCK_EM_CI !== 'true') return 1;
  }

  const credenciais = credenciaisDoAmbiente(env);

  console.log(
    `Competência ${competencia} · ${config.clientes.length} clientes · provedor padrão "${config.provedorPadrao}"`,
  );

  // Quatro janelas abrindo ao mesmo tempo, todas esperando captcha, seriam
  // inutilizáveis: quem resolve é uma pessoa, e uma pessoa faz uma de cada vez.
  const assistido = [config.provedorPadrao, ...Object.values(config.provedores)].includes(
    'assistido',
  );

  const execucao = await executar(config, credenciais, {
    concorrencia: assistido ? 1 : Number(args.concorrencia ?? 4),
    env,
    aoProgredir: ({ concluidas, total, resultado }) => {
      const s = descreverSituacao(resultado.situacao);
      console.log(
        `  [${String(concluidas).padStart(3)}/${total}] ${resultado.cliente} · ${resultado.certidaoNome}: ${s.rotulo}`,
      );

      // O que deu errado precisa aparecer aqui. Sem isso, todo diagnóstico
      // começa por abrir o JSON do histórico à procura do motivo.
      if (s.pendencia || s.manual) {
        const motivo = String(resultado.detalhe ?? '').trim();
        if (motivo) console.log(`        ${motivo.slice(0, 300)}`);
      }
    },
  });

  // Comparacao contra a ultima execucao anterior -- carregada antes de gravar a
  // desta competencia, senao ela compararia consigo mesma numa re-execucao.
  const pastaHistorico = resolve(pastaSaida, 'historico');
  const anterior = avulso ? null : await carregarAnterior(pastaHistorico, competencia);
  const comparacao = anterior ? compararComAnterior(execucao.resultados, anterior) : null;

  const html = gerarHtml({ competencia, execucao, config, comparacao });

  const arquivoHtml = resolve(pastaSaida, `relatorios/${competencia}.html`);
  const arquivoUltimo = resolve(pastaSaida, 'relatorios/ultimo.html');
  const arquivoJson = resolve(pastaSaida, `historico/${competencia}.json`);

  await mkdir(dirname(arquivoHtml), { recursive: true });
  await mkdir(dirname(arquivoJson), { recursive: true });
  await writeFile(arquivoHtml, html, 'utf8');
  await writeFile(arquivoUltimo, html, 'utf8');
  await writeFile(
    arquivoJson,
    `${JSON.stringify({ competencia, ...execucao }, null, 2)}\n`,
    'utf8',
  );

  // Índice das competências: uma página estática não consegue listar diretório,
  // e é por aqui que o painel descobre o que existe.
  await escreverIndice(pastaHistorico);

  const { resumo } = execucao;
  console.log(
    `\n${resumo.consultas} consultas · ${resumo.clientesComPendencia} de ${resumo.clientes} clientes exigem ação`,
  );
  if (comparacao) {
    console.log(
      `Desde ${comparacao.competenciaAnterior}: ${comparacao.mudancas.length} mudanças · ${comparacao.pioraram} pioraram · ${comparacao.melhoraram} melhoraram`,
    );
  }
  console.log(`Relatório: ${arquivoHtml}`);
  console.log(`Histórico: ${arquivoJson}`);

  for (const aviso of execucao.avisos) console.warn(`Aviso: ${aviso}`);

  return 0;
}

if (chamadoDireto(import.meta.url)) {
  principal().then(
    (codigo) => process.exit(codigo),
    (erro) => {
      console.error(`Erro: ${erro.message}`);
      process.exit(1);
    },
  );
}
