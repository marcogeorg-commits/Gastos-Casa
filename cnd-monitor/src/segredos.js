/**
 * Mascaramento de credenciais no que sai do processo.
 *
 * O relatorio e o historico guardam o texto devolvido pelo provedor, e esses
 * arquivos vao para o repositorio. Uma API que ecoa o token numa mensagem de
 * erro -- coisa comum -- vazaria a credencial para dentro do Git, onde ela fica
 * para sempre. Mascarar na saida e mais barato do que confiar que nenhum
 * provedor jamais fara isso.
 */

const TAMANHO_MINIMO = 8;

function escaparRegex(valor) {
  return valor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Valores secretos conhecidos, vindos das credenciais e do ambiente. */
export function coletarSegredos(credenciais = {}, env = process.env) {
  const candidatos = [
    credenciais.infosimples?.token,
    credenciais.serpro?.consumerKey,
    credenciais.serpro?.consumerSecret,
    env.INFOSIMPLES_TOKEN,
    env.SERPRO_CONSUMER_KEY,
    env.SERPRO_CONSUMER_SECRET,
  ];

  // Valores muito curtos gerariam mascaramento indiscriminado do texto.
  return [...new Set(candidatos.filter((v) => typeof v === 'string' && v.length >= TAMANHO_MINIMO))];
}

export function criarRedator(credenciais, env = process.env) {
  const segredos = coletarSegredos(credenciais, env);
  if (segredos.length === 0) return (texto) => texto;

  const padrao = new RegExp(segredos.map(escaparRegex).join('|'), 'g');
  return (texto) => (typeof texto === 'string' ? texto.replace(padrao, '[oculto]') : texto);
}
