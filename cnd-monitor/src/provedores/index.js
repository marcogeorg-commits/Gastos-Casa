import * as mock from './mock.js';
import * as infosimples from './infosimples.js';
import * as serpro from './serpro.js';
import * as web from './web.js';
import * as ecac from './ecac.js';
import * as assistido from './assistido.js';

export const PROVEDORES = { mock, infosimples, serpro, web, ecac, assistido };

/**
 * Ordem de preferencia do modo automatico.
 *
 * O e-CAC vem primeiro porque, onde ele funciona, entrega o que portal publico
 * nenhum entrega -- CADIN e Situacao Fiscal. Onde nao atende, cai na automacao
 * publica.
 */
const PREFERENCIA = ['ecac', 'web'];

/**
 * Cadeias de roteamento por modo escolhido.
 *
 * "assistido" tambem roteia: o modo assistido nao cobre CADIN nem Situacao
 * Fiscal, que so existem dentro do e-CAC. Sem isso, escolher assistido devolvia
 * "o provedor assistido nao atende cadin_federal" -- ruido de configuracao
 * disfarcado de resposta do orgao.
 */
const CADEIAS = {
  auto: PREFERENCIA,
  assistido: ['ecac', 'assistido'],
};

/** Cadeia de um modo, ou null quando o id for um provedor de verdade. */
export function cadeiaDe(modo) {
  return CADEIAS[modo] ?? null;
}

/**
 * Escolhe, por certidao, um provedor que de fato a atenda.
 *
 * Antes havia um provedor unico para a rodada inteira. Escolher "e-CAC" fazia
 * as outras seis certidoes voltarem com "o provedor ecac nao atende rfb_pgfn"
 * -- seis linhas de ruido que pareciam falha do orgao e eram falha de
 * roteamento. Uma escolha global nunca esteve certa: cada certidao tem um
 * caminho proprio.
 */
export function rotear(certidoes, preferencia = PREFERENCIA) {
  const mapa = {};

  for (const idCertidao of certidoes) {
    for (const idProvedor of preferencia) {
      const provedor = PROVEDORES[idProvedor];
      if (!provedor) continue;
      if (provedor.suporta ? provedor.suporta(idCertidao) : true) {
        mapa[idCertidao] = idProvedor;
        break;
      }
    }
  }
  return mapa;
}

export function obterProvedor(id) {
  const provedor = PROVEDORES[id];
  if (!provedor) {
    throw new Error(
      `Provedor desconhecido: "${id}". Disponiveis: ${Object.keys(PROVEDORES).join(', ')}.`,
    );
  }
  return provedor;
}
