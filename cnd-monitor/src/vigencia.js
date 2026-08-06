/**
 * Nao reemitir o que ainda esta valido.
 *
 * Uma CND federal vale 180 dias; a CRF do FGTS, 30. Consultar tudo todo mes
 * refaz trabalho que ja esta feito -- e no modo assistido cada consulta refeita
 * e um captcha a mais para uma pessoa resolver a toa. Aproveitar o que esta
 * vigente e o que separa "120 captchas por mes" de "os poucos que venceram".
 *
 * Tambem reduz a carga nos portais, o que importa: consulta publica automatizada
 * so continua tolerada enquanto tem ritmo de gente.
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { limpar } from './documentos.js';

/**
 * Chave do cache.
 *
 * O historico grava o documento formatado ("11.222.333/0001-81") e a rodada
 * trabalha com ele limpo. Comparar os dois como vieram fazia o cache nunca
 * casar com dado real -- e falhar em silencio, reconsultando tudo, que e a
 * falha que ninguem percebe porque o programa continua funcionando.
 */
export function chaveDe(documento, certidao) {
  return `${limpar(documento)}|${certidao}`;
}

/** Folga antes do vencimento: certidao que vence semana que vem ja e refeita. */
export const FOLGA_DIAS = 20;

/**
 * Aceita "31/12/2026" e "2026-12-31".
 *
 * Os portais escrevem a data como o brasileiro escreve; o historico guarda como
 * o computador ordena. Ler so um dos dois formatos faria o cache errar sempre
 * para metade das certidoes -- e errar para o lado de reemitir e barulhento,
 * mas errar para o lado de aproveitar e mentir sobre a situacao do cliente.
 */
export function comoData(valor) {
  const texto = String(valor ?? '').trim();

  const br = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;

  const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

/** Dias entre hoje e a data, negativo se ja passou. */
export function diasAte(data, hoje = new Date()) {
  const alvo = comoData(data);
  if (!alvo) return null;

  const umDia = 24 * 60 * 60 * 1000;
  const referencia = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate());
  const [a, m, d] = alvo.split('-').map(Number);

  return Math.round((Date.UTC(a, m - 1, d) - referencia) / umDia);
}

/**
 * Ultima certidao vigente de cada par cliente/certidao, lida do historico.
 *
 * Percorre do mais recente para o mais antigo e fica com a primeira ocorrencia
 * de cada par -- a mais nova e a que vale.
 */
export async function carregarVigentes(pastaHistorico, { folga = FOLGA_DIAS, hoje = new Date() } = {}) {
  let arquivos;
  try {
    arquivos = (await readdir(pastaHistorico)).filter((n) => n.endsWith('.json') && n !== 'index.json');
  } catch {
    return new Map();
  }

  const vigentes = new Map();

  // Do mais recente para o mais antigo: o nome comeca pela competencia ou pela
  // data da consulta avulsa, entao a ordem alfabetica decrescente serve.
  for (const nome of arquivos.sort().reverse()) {
    let dados;
    try {
      dados = JSON.parse(await readFile(resolve(pastaHistorico, nome), 'utf8'));
    } catch {
      continue;
    }

    for (const r of dados.resultados ?? []) {
      const chave = chaveDe(r.documento, r.certidao);
      if (vigentes.has(chave)) continue;
      if (!r.validaAte) continue;

      const dias = diasAte(r.validaAte, hoje);
      if (dias === null || dias < folga) continue;

      vigentes.set(chave, { ...r, diasRestantes: dias, origem: nome.replace(/\.json$/, '') });
    }
  }

  return vigentes;
}
