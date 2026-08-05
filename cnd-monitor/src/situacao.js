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

  // Falha temporária do portal: "Não foi possível concluir a ação para o
  // contribuinte informado. Por favor, tente novamente dentro de alguns
  // minutos. 023". Não diz nada sobre o cliente -- diz que o sistema não
  // respondeu. Confundir isso com pendência colocaria em vermelho quem está
  // regular, e vem antes das outras regras porque a frase não tem nenhuma das
  // palavras-chave usuais.
  if (
    t.includes('tente novamente') ||
    t.includes('nao foi possivel concluir') ||
    t.includes('sistema indisponivel') ||
    t.includes('servico indisponivel') ||
    t.includes('em manutencao')
  ) {
    return 'indisponivel';
  }

  // Desfecho comum no portal da Receita: "As informações disponíveis (...) são
  // insuficientes para emitir a certidão pela Internet". Não é negativa nem
  // positiva -- exige atendimento presencial ou e-CAC, e por isso vem antes de
  // qualquer outra regra: a frase contém "certidao" e nada mais que sirva.
  if (
    t.includes('insuficientes para emitir') ||
    t.includes('insuficiente para emitir') ||
    t.includes('nao foi possivel emitir') ||
    t.includes('nao e possivel emitir')
  ) {
    return 'nao_emitida';
  }

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
