import { CATALOGO, descreverSituacao } from './catalogo.js';
import { provedorDe } from './config.js';
import { obterProvedor } from './provedores/index.js';
import { criarRedator } from './segredos.js';

const CONCORRENCIA_PADRAO = 4;
const TENTATIVAS = 3;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Provedores que cobram por consulta -- os que o teto de gasto vigia. */
const PROVEDORES_PAGOS = new Set(['infosimples', 'serpro']);

/**
 * Plano de execucao: o que seria consultado, por provedor, sem tocar na rede.
 * E o que permite ver a conta antes de gasta-la.
 */
export function planejar(config) {
  const porProvedor = {};
  let cobraveis = 0;

  for (const { idCertidao, certidao } of montarTarefas(config)) {
    const provedor = certidao.apenasManual ? 'manual' : provedorDe(config, idCertidao);
    porProvedor[provedor] = (porProvedor[provedor] ?? 0) + 1;
    if (PROVEDORES_PAGOS.has(provedor)) cobraveis += 1;
  }

  return { porProvedor, cobraveis, total: montarTarefas(config).length };
}

/** Monta a lista plana de consultas (cliente x certidao). */
export function montarTarefas(config) {
  const tarefas = [];
  for (const cliente of config.clientes) {
    for (const idCertidao of cliente.certidoes) {
      tarefas.push({ cliente, idCertidao, certidao: CATALOGO[idCertidao] });
    }
  }
  return tarefas;
}

async function comRetentativa(fn, tentativas = TENTATIVAS) {
  let ultimoErro;
  for (let i = 1; i <= tentativas; i += 1) {
    try {
      return await fn();
    } catch (erro) {
      ultimoErro = erro;
      if (i < tentativas) await esperar(1000 * 2 ** (i - 1));
    }
  }
  throw ultimoErro;
}

/** Executa `tarefas` respeitando um limite de chamadas simultaneas. */
async function emLotes(tarefas, concorrencia, fn) {
  const resultados = new Array(tarefas.length);
  let proxima = 0;

  const trabalhador = async () => {
    while (proxima < tarefas.length) {
      const i = proxima;
      proxima += 1;
      resultados[i] = await fn(tarefas[i], i);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concorrencia, tarefas.length) }, trabalhador),
  );
  return resultados;
}

export async function executar(config, credenciais, opcoes = {}) {
  const { concorrencia = CONCORRENCIA_PADRAO, aoProgredir, env = process.env } = opcoes;
  const tarefas = montarTarefas(config);
  const avisos = [...config.avisos];
  const redigir = criarRedator(credenciais, env);

  // Teto de gasto: um cadastro duplicado ou um laco errado nao pode virar
  // fatura. Aborta antes de consultar, nao no meio.
  const plano = planejar(config);
  const limite = config.limiteConsultas ?? null;
  if (limite !== null && plano.cobraveis > limite) {
    throw new Error(
      `A rodada faria ${plano.cobraveis} consultas cobradas, acima do limite de ${limite}. ` +
        'Ajuste "limiteConsultas" em clientes.json se o aumento for intencional.',
    );
  }

  // Uma verificacao de credencial por provedor, nao por consulta.
  const provedoresIndisponiveis = new Map();
  for (const idCertidao of new Set(tarefas.map((t) => t.idCertidao))) {
    if (CATALOGO[idCertidao].apenasManual) continue;
    const idProvedor = provedorDe(config, idCertidao);
    if (provedoresIndisponiveis.has(idProvedor)) continue;

    const provedor = obterProvedor(idProvedor);
    const faltando = provedor.credenciaisFaltando(credenciais);
    if (faltando.length > 0) {
      provedoresIndisponiveis.set(idProvedor, faltando);
      avisos.push(
        `Provedor "${idProvedor}" sem credenciais (${faltando.join(', ')}) — consultas marcadas como falha.`,
      );
    }
  }

  let concluidas = 0;
  let resultados;
  try {
    resultados = await emLotes(tarefas, concorrencia, async (tarefa) => {
      const bruto = await consultarUma(tarefa, config, credenciais, {
        provedoresIndisponiveis,
        env,
      });
      // O detalhe vai para o histórico versionado: credencial ecoada pela API
      // não pode chegar lá.
      const resultado = { ...bruto, detalhe: redigir(bruto.detalhe) };
      concluidas += 1;
      aoProgredir?.({ concluidas, total: tarefas.length, resultado });
      return resultado;
    });
  } finally {
    // Provedores com recurso pesado (o "web" mantem um Chromium aberto para a
    // rodada inteira) precisam desligar mesmo se algo estourar no meio.
    await encerrarProvedores(config, tarefas);
  }

  return {
    geradoEm: new Date().toISOString(),
    avisos,
    resultados,
    resumo: resumir(resultados),
  };
}

async function encerrarProvedores(config, tarefas) {
  const usados = new Set(
    tarefas
      .filter((t) => !t.certidao.apenasManual)
      .map((t) => provedorDe(config, t.idCertidao)),
  );

  for (const idProvedor of usados) {
    try {
      const provedor = obterProvedor(idProvedor);
      if (provedor.encerrar) await provedor.encerrar();
    } catch {
      // Encerramento e best-effort: nao pode mascarar o resultado da rodada.
    }
  }
}

async function consultarUma(tarefa, config, credenciais, ctx) {
  const { cliente, certidao, idCertidao } = tarefa;
  const base = {
    cliente: cliente.nome,
    documento: cliente.documentoFormatado,
    tipo: cliente.tipo,
    municipio: cliente.municipio,
    certidao: idCertidao,
    certidaoNome: certidao.nome,
    orgao: certidao.orgao,
    urlManual: certidao.urlManual,
  };

  if (certidao.apenasManual) {
    return {
      ...base,
      provedor: null,
      situacao: 'manual',
      detalhe: certidao.motivoManual,
    };
  }

  const idProvedor = provedorDe(config, idCertidao);

  if (ctx.provedoresIndisponiveis.has(idProvedor)) {
    return {
      ...base,
      provedor: idProvedor,
      situacao: 'erro',
      detalhe: `Credenciais ausentes: ${ctx.provedoresIndisponiveis.get(idProvedor).join(', ')}.`,
    };
  }

  try {
    const provedor = obterProvedor(idProvedor);
    const resultado = await comRetentativa(() =>
      provedor.consultar({ cliente, certidao, idCertidao, credenciais, env: ctx.env }),
    );
    return { ...base, provedor: idProvedor, ...resultado };
  } catch (erro) {
    return {
      ...base,
      provedor: idProvedor,
      situacao: 'erro',
      detalhe: erro.message ?? String(erro),
    };
  }
}

export function resumir(resultados) {
  const porSituacao = {};
  const clientesComPendencia = new Set();
  let manuais = 0;

  for (const r of resultados) {
    const s = descreverSituacao(r.situacao);
    porSituacao[r.situacao] = (porSituacao[r.situacao] ?? 0) + 1;
    if (s.pendencia) clientesComPendencia.add(r.documento);
    if (s.manual) manuais += 1;
  }

  return {
    consultas: resultados.length,
    clientes: new Set(resultados.map((r) => r.documento)).size,
    clientesComPendencia: clientesComPendencia.size,
    manuais,
    porSituacao,
  };
}
