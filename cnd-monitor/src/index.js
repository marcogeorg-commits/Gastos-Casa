#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarConfig, credenciaisDoAmbiente } from './config.js';
import { descreverSituacao } from './catalogo.js';
import { executar, planejar } from './executor.js';
import { gerarHtml } from './relatorio.js';
import { carregarAnterior, compararComAnterior, escreverIndice } from './historico.js';

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

export async function principal(argv = process.argv.slice(2), env = process.env) {
  const args = lerArgumentos(argv);

  if (args.ajuda || args.help) {
    console.log(`
cnd-monitor — consulta mensal de certidões da carteira de clientes

  --clientes <arquivo>     padrão: clientes.json
  --provedor <id>          sobrescreve o provedorPadrao (mock | infosimples | serpro)
  --competencia <AAAA-MM>  padrão: mês corrente
  --saida <pasta>          padrão: raiz do cnd-monitor
  --concorrencia <n>       consultas simultâneas (padrão 4)
  --simular                mostra o que seria consultado, sem tocar na rede
`);
    return 0;
  }

  const caminhoClientes = resolve(RAIZ, args.clientes ?? 'clientes.json');
  const competencia = args.competencia ?? competenciaAtual();
  const pastaSaida = resolve(RAIZ, args.saida ?? '.');

  const config = await carregarConfig(caminhoClientes);
  if (args.provedor) {
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

  const execucao = await executar(config, credenciais, {
    concorrencia: Number(args.concorrencia ?? 4),
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
  const anterior = await carregarAnterior(pastaHistorico, competencia);
  const comparacao = compararComAnterior(execucao.resultados, anterior);

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

if (import.meta.url === `file://${process.argv[1]}`) {
  principal().then(
    (codigo) => process.exit(codigo),
    (erro) => {
      console.error(`Erro: ${erro.message}`);
      process.exit(1);
    },
  );
}
