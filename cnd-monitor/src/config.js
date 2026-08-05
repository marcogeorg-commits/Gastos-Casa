import { readFile } from 'node:fs/promises';
import { CATALOGO, IDS_CERTIDOES } from './catalogo.js';
import { formatar, limpar, tipoDocumento, validar } from './documentos.js';

const PROVEDOR_PADRAO = 'mock';

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
      certidoes,
    });
  }

  if (clientes.length === 0) {
    throw new Error(`Nenhum cliente válido em ${caminho}.`);
  }

  return { provedorPadrao, provedores, certidoesAtivas, clientes, avisos };
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
