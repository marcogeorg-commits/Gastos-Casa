/**
 * Provedor simulado. Nao acessa a rede: serve para validar a rotina inteira
 * (cadastro, execucao, relatorio, historico) antes de contratar qualquer API.
 *
 * O resultado e deterministico -- derivado do documento e da certidao -- para
 * que rodadas repetidas produzam o mesmo relatorio.
 */

export const id = 'mock';
export const nome = 'Simulado (sem rede)';

export function credenciaisFaltando() {
  return [];
}

function hash(texto) {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function somarDias(base, dias) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export async function consultar({ cliente, certidao, idCertidao, referencia }) {
  const semente = hash(`${cliente.documento}|${idCertidao}`);
  const sorteio = semente % 100;

  const hoje = referencia?.emitidaEm ?? new Date().toISOString().slice(0, 10);

  if (sorteio < 70) {
    return {
      situacao: 'negativa',
      detalhe: 'Nenhuma pendência localizada (dado simulado).',
      numeroCertidao: `SIM-${semente.toString(36).toUpperCase().slice(0, 10)}`,
      emitidaEm: hoje,
      validaAte: certidao.validadeDias ? somarDias(hoje, certidao.validadeDias) : null,
    };
  }

  if (sorteio < 85) {
    return {
      situacao: 'positiva_com_efeito_negativo',
      detalhe: 'Débitos com exigibilidade suspensa (dado simulado).',
      numeroCertidao: `SIM-${semente.toString(36).toUpperCase().slice(0, 10)}`,
      emitidaEm: hoje,
      validaAte: certidao.validadeDias ? somarDias(hoje, certidao.validadeDias) : null,
    };
  }

  if (sorteio < 95) {
    return {
      situacao: 'positiva',
      detalhe: 'Há débitos impeditivos à emissão da certidão (dado simulado).',
      emitidaEm: hoje,
    };
  }

  return {
    situacao: 'erro',
    detalhe: 'Portal do órgão indisponível no momento da consulta (dado simulado).',
  };
}
