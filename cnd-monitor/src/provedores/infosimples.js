/**
 * Provedor Infosimples (https://infosimples.com/consultas/).
 *
 * A Infosimples expoe cada consulta como um endpoint REST no padrao
 *   POST https://api.infosimples.com/api/v2/consulta/<orgao>/<servico>
 * com `token` no corpo e resposta { code, code_message, data: [...] }.
 *
 * ATENCAO AOS SLUGS: apenas `receita-federal/pgfn` foi confirmado na
 * documentacao publica. Os demais estao marcados com `confirmar: true` --
 * confira o slug exato no painel da Infosimples antes de ativar a certidao
 * correspondente, ou sobrescreva pela variavel INFOSIMPLES_ENDPOINTS
 * (JSON no formato {"cndt": "tst/cndt"}).
 */

import { interpretarTexto } from '../situacao.js';
import { buscarComRetentativa } from '../http.js';

export const id = 'infosimples';
export const nome = 'Infosimples';

export const ENDPOINTS = {
  rfb_pgfn: { caminho: 'receita-federal/pgfn', confirmar: false },
  fgts_crf: { caminho: 'caixa/regularidade', confirmar: true },
  cndt: { caminho: 'tst/cndt', confirmar: true },
  sefaz_sc: { caminho: 'sefaz/sc/cnd', confirmar: true },
  municipal: { caminho: null, confirmar: true },
};

export function credenciaisFaltando(credenciais) {
  return credenciais?.infosimples?.token ? [] : ['INFOSIMPLES_TOKEN'];
}

function endpointsCustomizados(env = process.env) {
  if (!env.INFOSIMPLES_ENDPOINTS) return {};
  try {
    return JSON.parse(env.INFOSIMPLES_ENDPOINTS);
  } catch {
    return {};
  }
}

export function resolverEndpoint(idCertidao, env = process.env) {
  const custom = endpointsCustomizados(env)[idCertidao];
  if (custom) return custom;
  return ENDPOINTS[idCertidao]?.caminho ?? null;
}

/** Ver `src/situacao.js` -- a regra e a mesma para todos os provedores. */
export const interpretarSituacao = interpretarTexto;

function primeiro(dados, ...chaves) {
  for (const item of dados ?? []) {
    for (const chave of chaves) {
      if (item?.[chave]) return item[chave];
    }
  }
  return null;
}

export async function consultar({ cliente, idCertidao, credenciais, env = process.env }) {
  const { token, baseUrl, timeout } = credenciais.infosimples;
  const caminho = resolverEndpoint(idCertidao, env);

  if (!caminho) {
    return {
      situacao: 'manual',
      detalhe:
        `Endpoint Infosimples não configurado para "${idCertidao}". Defina-o em INFOSIMPLES_ENDPOINTS.`,
    };
  }

  const corpo = {
    token,
    timeout,
    [cliente.tipo]: cliente.documento,
  };
  if (cliente.municipio) corpo.municipio = cliente.municipio;

  const resposta = await buscarComRetentativa(`${baseUrl}/${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(corpo),
  });

  const json = await resposta.json().catch(() => null);

  if (!json) {
    return { situacao: 'erro', detalhe: `Resposta ilegível (HTTP ${resposta.status}).` };
  }

  // A Infosimples devolve HTTP 200 mesmo em erro de negocio; o que vale e `code`.
  if (json.code !== 200) {
    const situacao = interpretarSituacao(json.code_message);
    return {
      situacao: situacao ?? 'erro',
      detalhe: `[${json.code}] ${json.code_message ?? 'erro não descrito'}`,
    };
  }

  const dados = json.data ?? [];
  const textoSituacao =
    primeiro(dados, 'situacao', 'tipo_certidao', 'resultado', 'mensagem') ?? '';

  return {
    situacao: interpretarSituacao(textoSituacao) ?? 'negativa',
    detalhe: String(textoSituacao || 'Certidão emitida com sucesso.'),
    numeroCertidao: primeiro(dados, 'numero_certidao', 'codigo_controle', 'numero'),
    emitidaEm: primeiro(dados, 'data_emissao', 'emissao'),
    validaAte: primeiro(dados, 'data_validade', 'validade'),
    pdfUrl: (json.site_receipts ?? [])[0] ?? primeiro(dados, 'url_pdf', 'pdf'),
  };
}
