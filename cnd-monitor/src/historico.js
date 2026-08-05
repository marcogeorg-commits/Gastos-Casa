import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { descreverSituacao } from './catalogo.js';

const ARQUIVO_COMPETENCIA = /^(\d{4}-\d{2})\.json$/;

/**
 * Gravidade relativa de cada situacao. E o que permite dizer se um cliente
 * piorou ou melhorou entre duas competencias -- comparar os nomes das situacoes
 * so diria que "mudou", que e a informacao inutil.
 */
const GRAVIDADE = {
  negativa: 0,
  positiva_com_efeito_negativo: 0,
  sem_registro: 0,
  nao_aplicavel: 0,
  manual: 1,
  erro: 2,
  nao_emitida: 3,
  positiva: 3,
};

export function gravidade(situacao) {
  return GRAVIDADE[situacao] ?? 2;
}

/** Competencias disponiveis no historico, da mais antiga para a mais recente. */
export async function listarCompetencias(pasta) {
  try {
    const arquivos = await readdir(pasta);
    return arquivos
      .map((nome) => nome.match(ARQUIVO_COMPETENCIA)?.[1])
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Carrega a competencia imediatamente anterior a `competencia`.
 *
 * Anterior e a ultima que existe antes dela, nao "o mes passado": se a rotina
 * nao rodou em algum mes, a comparacao ainda faz sentido contra a ultima
 * execucao real.
 */
export async function carregarAnterior(pasta, competencia) {
  const anteriores = (await listarCompetencias(pasta)).filter((c) => c < competencia);
  const alvo = anteriores.at(-1);
  if (!alvo) return null;

  try {
    const conteudo = JSON.parse(await readFile(resolve(pasta, `${alvo}.json`), 'utf8'));
    return { competencia: alvo, ...conteudo };
  } catch {
    return null;
  }
}

const chave = (r) => `${r.documento}|${r.certidao}`;

/**
 * Compara duas execucoes e devolve so o que mudou.
 *
 * Um relatorio mensal sem memoria trata igual quem sempre esteve irregular e
 * quem acabou de ficar -- e a segunda e a que exige ligacao hoje.
 */
export function compararComAnterior(resultados, anterior) {
  if (!anterior) return null;

  const antes = new Map((anterior.resultados ?? []).map((r) => [chave(r), r]));
  const mudancas = [];

  for (const atual of resultados) {
    const previo = antes.get(chave(atual));

    if (!previo) {
      mudancas.push({ tipo: 'novo', atual, anterior: null });
      continue;
    }
    if (previo.situacao === atual.situacao) continue;

    const delta = gravidade(atual.situacao) - gravidade(previo.situacao);
    mudancas.push({
      tipo: delta > 0 ? 'piorou' : delta < 0 ? 'melhorou' : 'mudou',
      atual,
      anterior: previo,
    });
  }

  // Some quem sumiu do cadastro -- cliente removido tambem e uma mudanca.
  const agora = new Set(resultados.map(chave));
  for (const previo of anterior.resultados ?? []) {
    if (!agora.has(chave(previo))) {
      mudancas.push({ tipo: 'removido', atual: null, anterior: previo });
    }
  }

  const ordem = { piorou: 0, novo: 1, mudou: 2, melhorou: 3, removido: 4 };
  mudancas.sort(
    (a, b) =>
      ordem[a.tipo] - ordem[b.tipo] ||
      (a.atual ?? a.anterior).cliente.localeCompare(
        (b.atual ?? b.anterior).cliente,
        'pt-BR',
      ),
  );

  return {
    competenciaAnterior: anterior.competencia,
    mudancas,
    pioraram: mudancas.filter((m) => m.tipo === 'piorou').length,
    melhoraram: mudancas.filter((m) => m.tipo === 'melhorou').length,
  };
}

/** Rotulo curto de uma transicao, para o relatorio. */
export function descreverMudanca(mudanca) {
  const de = mudanca.anterior ? descreverSituacao(mudanca.anterior.situacao).rotulo : null;
  const para = mudanca.atual ? descreverSituacao(mudanca.atual.situacao).rotulo : null;

  if (mudanca.tipo === 'novo') return `passou a ser monitorada — ${para}`;
  if (mudanca.tipo === 'removido') return `saiu do monitoramento — estava ${de}`;
  return `${de} → ${para}`;
}

/**
 * Grava `historico/index.json` com o resumo de cada competencia.
 *
 * Uma pagina estatica nao consegue listar diretorio: sem esse indice o painel
 * nao teria como descobrir quais competencias existem.
 */
export async function escreverIndice(pasta) {
  const competencias = await listarCompetencias(pasta);
  const entradas = [];

  for (const competencia of competencias) {
    try {
      const dados = JSON.parse(await readFile(resolve(pasta, `${competencia}.json`), 'utf8'));
      entradas.push({
        competencia,
        geradoEm: dados.geradoEm ?? null,
        resumo: dados.resumo ?? null,
      });
    } catch {
      // Competência ilegível não invalida o índice das outras.
    }
  }

  await writeFile(
    resolve(pasta, 'index.json'),
    `${JSON.stringify({ competencias: entradas.reverse() }, null, 2)}\n`,
    'utf8',
  );
  return entradas;
}
