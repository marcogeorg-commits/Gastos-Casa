/**
 * Chamada HTTP com retentativa para o que e transitorio.
 *
 * A retentativa generica do executor so pega excecao. Uma API responde 429 ou
 * 503 com HTTP 200-ish do ponto de vista do fetch -- sem tratar isso, um pico
 * momentaneo no provedor viraria "falha na consulta" no relatorio e o cliente
 * apareceria em vermelho sem ter nada de errado.
 */

const TENTATIVAS = 4;
const ESPERA_BASE = 1000;
const ESPERA_MAXIMA = 30_000;

/** 429 e 5xx sao transitorios; 4xx restante e erro nosso e nao adianta insistir. */
export function ehTransitorio(status) {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

/** Respeita `Retry-After` quando o servidor diz quanto esperar. */
export function esperaSugerida(resposta, tentativa) {
  const cabecalho = resposta?.headers?.get?.('retry-after');
  const segundos = Number(cabecalho);

  if (Number.isFinite(segundos) && segundos > 0) {
    return Math.min(segundos * 1000, ESPERA_MAXIMA);
  }
  return Math.min(ESPERA_BASE * 2 ** (tentativa - 1), ESPERA_MAXIMA);
}

export async function buscarComRetentativa(url, opcoes = {}, config = {}) {
  const {
    tentativas = TENTATIVAS,
    dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
    buscar = fetch,
  } = config;

  let ultimaResposta;
  let ultimoErro;

  for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
    try {
      const resposta = await buscar(url, opcoes);
      if (!ehTransitorio(resposta.status)) return resposta;
      ultimaResposta = resposta;
    } catch (erro) {
      ultimoErro = erro; // Rede caiu: mesma política de espera.
    }

    if (tentativa < tentativas) await dormir(esperaSugerida(ultimaResposta, tentativa));
  }

  if (ultimaResposta) return ultimaResposta;
  throw ultimoErro;
}
