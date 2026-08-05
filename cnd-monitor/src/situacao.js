/**
 * Traducao de texto livre de certidao para as situacoes normalizadas.
 *
 * Cada orgao escreve de um jeito ("Certidão Negativa", "Nada consta",
 * "Empregador regular"), entao o casamento e por palavra-chave, do caso mais
 * especifico para o mais generico. Sempre sem acentos: os portais alternam.
 */

export function semAcento(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export function interpretarTexto(texto) {
  const t = semAcento(texto);
  if (!t) return null;

  // Mais especifico primeiro: "positiva com efeito de negativa" contem as duas
  // palavras e nao pode cair na regra de "negativa".
  if (t.includes('positiva com efeito') || t.includes('efeito de negativa')) {
    return 'positiva_com_efeito_negativo';
  }

  // Antes de "negativa": "irregular" contem "regular", e um resultado ruim nao
  // pode ser lido como bom por acidente.
  if (t.includes('irregular') || t.includes('positiva') || t.includes('pendencia')) {
    return 'positiva';
  }

  if (t.includes('negativa') || t.includes('nada consta') || /\bregular\b/.test(t)) {
    return 'negativa';
  }

  return null;
}
