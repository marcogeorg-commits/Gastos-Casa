/**
 * Provedor SERPRO -- API Consulta CND (fonte oficial RFB/PGFN).
 *
 * Fluxo: POST no /token com Basic base64(consumerKey:consumerSecret) e
 * grant_type=client_credentials, depois GET na consulta com Bearer.
 *
 * O endpoint do token esta documentado publicamente. O caminho da consulta
 * varia conforme a versao contratada -- confirme na documentacao do seu
 * contrato e ajuste SERPRO_BASE_URL / SERPRO_CAMINHO_CERTIDAO se necessario.
 *
 * Cobre apenas a CND Federal: e o unico servico deste contrato.
 */

export const id = 'serpro';
export const nome = 'SERPRO (Consulta CND)';

export const CERTIDOES_SUPORTADAS = ['rfb_pgfn'];

export function credenciaisFaltando(credenciais) {
  const faltando = [];
  if (!credenciais?.serpro?.consumerKey) faltando.push('SERPRO_CONSUMER_KEY');
  if (!credenciais?.serpro?.consumerSecret) faltando.push('SERPRO_CONSUMER_SECRET');
  return faltando;
}

let tokenCache = null;

/** Reaproveita o bearer token enquanto valido -- 20 clientes x N certidoes. */
export async function obterToken(credenciais, agora = Date.now()) {
  if (tokenCache && tokenCache.expiraEm > agora + 30_000) return tokenCache.valor;

  const { consumerKey, consumerSecret, tokenUrl } = credenciais.serpro;
  const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const resposta = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!resposta.ok) {
    throw new Error(`Falha ao obter token SERPRO (HTTP ${resposta.status}).`);
  }

  const json = await resposta.json();
  tokenCache = {
    valor: json.access_token,
    expiraEm: agora + (Number(json.expires_in ?? 3600) * 1000),
  };
  return tokenCache.valor;
}

export function limparCacheDeToken() {
  tokenCache = null;
}

export function interpretarSituacao(payload) {
  const semAcento = (v) =>
    String(v ?? '')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  const texto = `${semAcento(payload?.tipoCertidao ?? payload?.tipo)} ${semAcento(
    payload?.situacao ?? payload?.status,
  )}`;

  if (texto.includes('positiva com efeito') || texto.includes('efeito de negativa')) {
    return 'positiva_com_efeito_negativo';
  }
  if (texto.includes('negativa')) return 'negativa';
  if (texto.includes('positiva') || texto.includes('pendencia')) return 'positiva';
  return null;
}

export async function consultar({ cliente, idCertidao, credenciais, env = process.env }) {
  if (!CERTIDOES_SUPORTADAS.includes(idCertidao)) {
    return {
      situacao: 'erro',
      detalhe: `O contrato Consulta CND do SERPRO não atende "${idCertidao}". Use outro provedor para esta certidão.`,
    };
  }

  const token = await obterToken(credenciais);
  const base = credenciais.serpro.baseUrl;
  const caminho = env.SERPRO_CAMINHO_CERTIDAO ?? 'certidao';
  const url = `${base}/${caminho}/${cliente.tipo}/${cliente.documento}`;

  const resposta = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  if (resposta.status === 404) {
    return { situacao: 'sem_registro', detalhe: 'Nenhuma certidão localizada para o documento.' };
  }

  if (!resposta.ok) {
    const texto = await resposta.text().catch(() => '');
    return {
      situacao: 'erro',
      detalhe: `HTTP ${resposta.status} ${texto.slice(0, 200)}`.trim(),
    };
  }

  const json = await resposta.json().catch(() => null);
  if (!json) return { situacao: 'erro', detalhe: 'Resposta do SERPRO não é JSON válido.' };

  const payload = Array.isArray(json) ? json[0] : json;

  return {
    situacao: interpretarSituacao(payload) ?? 'negativa',
    detalhe: payload?.tipoCertidao ?? payload?.situacao ?? 'Certidão consultada no Sistema CND.',
    numeroCertidao: payload?.numeroCertidao ?? payload?.codigoControle ?? null,
    emitidaEm: payload?.dataEmissao ?? null,
    validaAte: payload?.dataValidade ?? null,
  };
}
