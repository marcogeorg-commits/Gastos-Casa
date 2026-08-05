#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarConfig, credenciaisDoAmbiente } from './config.js';
import { descreverSituacao } from './catalogo.js';
import { executar } from './executor.js';
import { gerarHtml } from './relatorio.js';
import { carregarAnterior, compararComAnterior } from './historico.js';

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
