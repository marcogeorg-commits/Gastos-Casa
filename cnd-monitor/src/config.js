import { readFile } from 'node:fs/promises';
import { CATALOGO, IDS_CERTIDOES } from './catalogo.js';
import { formatar, limpar, tipoDocumento, validar } from './documentos.js';

const PROVEDOR_PADRAO = 'mock';

/** Pasta irma do projeto: junto do programa, fora do repositorio. */
export const PASTA_CERTIFICADOS_PADRAO = '../Certificados';

/**
 * Le o arquivo de clientes e devolve uma configuracao normalizada.
 * Erros de cadastro sao acumulados em `avisos` em vez de interromper a rotina:
 * um CNPJ digitado errado nao pode impedir a consulta dos outros 19 clientes.
 */
export async function carregarConfig(caminho) {
  let bruto;
  try {
    bruto = JSON.parse(await readFile(caminho, 'utf8'));
  } catch (erro) {
    throw new Error(`Não foi possível ler ${caminho}: ${erro.message}`);
  }

  const avisos = [];
  const provedorPadrao = bruto.provedorPadrao ?? PROVEDOR_PADRAO;
  const provedores = { ...(bruto.provedores ?? {}) };

  const certidoesAtivas = (bruto.certidoes ?? IDS_CERTIDOES).filter((id) => {
    if (CATALOGO[id]) return true;
    avisos.push(`Certidão desconhecida ignorada: "${id}"`);
    return false;
  });

  const clientes = [];
  for (const [i, cru] of (bruto.clientes ?? []).entries()) {
    const rotulo = cru.nome || cru.documento || `cliente #${i + 1}`;

    if (cru.ativo === false) continue;

    const documento = limpar(cru.documento);
    const tipo = tipoDocumento(documento);

    if (!tipo) {
      avisos.push(`${rotulo}: documento "${cru.documento}" não parece CPF nem CNPJ — cliente ignorado.`);
      continue;
    }
    if (!validar(documento)) {
      avisos.push(`${rotulo}: ${formatar(documento)} tem dígito verificador inválido — cliente ignorado.`);
      continue;
    }

    const certidoes = (cru.certidoes ?? certidoesAtivas).filter((id) => {
      const meta = CATALOGO[id];
      if (!meta) {
        avisos.push(`${rotulo}: certidão desconhecida "${id}" ignorada.`);
        return false;
      }
      if (!meta.aceita.includes(tipo)) return false;
      if (meta.exigeMunicipio && !cru.municipio) {
        avisos.push(`${rotulo}: "${meta.nome}" exige o campo "municipio" no cadastro — certidão pulada.`);
        return false;
      }
      return true;
    });

    clientes.push({
      nome: cru.nome ?? formatar(documento),
      documento,
      documentoFormatado: formatar(documento),
      tipo,
      municipio: cru.municipio ?? null,
      // Exigida por alguns portais na emissao para pessoa fisica.
      dataNascimento: cru.dataNascimento ?? null,
      uf: cru.uf ?? null,
      observacao: cru.observacao ?? null,
      // O certificado é por cliente; a senha nunca vem daqui (ver certificados.js).
      certificado: cru.certificado ?? null,
      certidoes,
    });
  }

  if (clientes.length === 0) {
    throw new Error(`Nenhum cliente válido em ${caminho}.`);
  }

  return {
    provedorPadrao,
    provedores,
    certidoesAtivas,
    clientes,
    avisos,
    limiteConsultas: bruto.limiteConsultas ?? null,
    // A pasta irma e a estrutura recomendada; sem esse padrao, um cadastro que
    // nunca passou pela aba Certificados procuraria os .pfx dentro do projeto.
    certificados: { pastaPadrao: PASTA_CERTIFICADOS_PADRAO, ...(bruto.certificados ?? {}) },
  };
}

/**
 * Configuracao de uma consulta avulsa: um documento, sem passar pelo cadastro.
 *
 * O uso mais comum do escritorio nao e a rodada mensal: e o telefone tocando
 * com "da uma olhada no CNPJ tal". Obrigar a cadastrar o cliente antes de
 * poder consultar transformava um minuto em cinco -- e sujava a carteira com
 * quem so passou por ali.
 *
 * Nao toca em `clientes.json` nem no historico: e uma pergunta, nao um
 * acompanhamento.
 */
export function configAvulsa({
  documento,
  certidoes = null,
  provedor = 'web',
  municipio = null,
  dataNascimento = null,
  certificados = {},
}) {
  const limpo = limpar(documento);
  const tipo = tipoDocumento(limpo);

  if (!tipo) throw new Error(`"${documento}" não parece um CPF nem um CNPJ.`);
  if (!validar(limpo)) {
    throw new Error(`${formatar(limpo)} tem dígito verificador inválido — confira a digitação.`);
  }

  const avisos = [];
  const pedidas = certidoes?.length ? certidoes : IDS_CERTIDOES;

  const ativas = pedidas.filter((id) => {
    const meta = CATALOGO[id];
    if (!meta) {
      avisos.push(`Certidão desconhecida ignorada: "${id}"`);
      return false;
    }
    if (!meta.aceita.includes(tipo)) return false;
    if (meta.exigeMunicipio && !municipio) {
      avisos.push(`"${meta.nome}" exige o município — informe-o para incluí-la.`);
      return false;
    }
    return true;
  });

  if (ativas.length === 0) {
    throw new Error(`Nenhuma das certidões escolhidas se aplica a este ${tipo.toUpperCase()}.`);
  }

  return {
    provedorPadrao: provedor,
    provedores: {},
    certidoesAtivas: ativas,
    clientes: [
      {
        nome: formatar(limpo),
        documento: limpo,
        documentoFormatado: formatar(limpo),
        tipo,
        municipio,
        dataNascimento,
        uf: null,
        observacao: null,
        certificado: null,
        certidoes: ativas,
      },
    ],
    avisos,
    limiteConsultas: null,
    certificados,
  };
}

/** Provedor efetivo de uma certidao, considerando o override por certidao. */
export function provedorDe(config, idCertidao) {
  return config.provedores[idCertidao] ?? config.provedorPadrao;
}

/** Credenciais lidas do ambiente (GitHub Secrets em producao). */
export function credenciaisDoAmbiente(env = process.env) {
  return {
    infosimples: {
      token: env.INFOSIMPLES_TOKEN ?? null,
      baseUrl: env.INFOSIMPLES_BASE_URL ?? 'https://api.infosimples.com/api/v2/consulta',
      timeout: Number(env.INFOSIMPLES_TIMEOUT ?? 600),
    },
    serpro: {
      consumerKey: env.SERPRO_CONSUMER_KEY ?? null,
      consumerSecret: env.SERPRO_CONSUMER_SECRET ?? null,
      tokenUrl: env.SERPRO_TOKEN_URL ?? 'https://gateway.apiserpro.serpro.gov.br/token',
      baseUrl:
        env.SERPRO_BASE_URL ?? 'https://gateway.apiserpro.serpro.gov.br/consulta-cnd/api/v1',
    },
  };
}
