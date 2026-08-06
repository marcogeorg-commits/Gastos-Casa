/**
 * Identidade visual compartilhada.
 *
 * O painel e o relatorio precisam parecer a mesma coisa, mas sao servidos de
 * jeitos diferentes: o painel carrega `painel/marca.css` por <link>, e o
 * relatorio embute o mesmo texto -- ele tem que abrir com dois cliques, longe
 * do servidor, e sobreviver a um encaminhamento de e-mail. Ler o arquivo aqui
 * evita a copia que um dia sairia do lugar.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CSS_MARCA = readFileSync(resolve(RAIZ, 'painel/marca.css'), 'utf8');

export const SITE = 'abcincembralot.com.br';

/** Extensoes aceitas como logotipo, na ordem de preferencia. */
const ARQUIVOS_LOGO = ['painel/logo.svg', 'painel/logo.png'];

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png' };

/**
 * Logotipo embutido como data URI, quando houver arquivo.
 *
 * O relatorio e um arquivo solto: referenciar `logo.svg` por caminho daria
 * imagem quebrada assim que ele saisse da pasta. Sem arquivo, devolve null e o
 * cabecalho cai no logotipo tipografico.
 */
export function logoEmbutido(raiz = RAIZ) {
  for (const relativo of ARQUIVOS_LOGO) {
    try {
      const bytes = readFileSync(resolve(raiz, relativo));
      const extensao = relativo.slice(relativo.lastIndexOf('.'));
      return `data:${MIME[extensao]};base64,${bytes.toString('base64')}`;
    } catch {
      // Sem esse arquivo; tenta o proximo.
    }
  }
  return null;
}

/**
 * Assinatura da casa.
 *
 * Enquanto nao houver `painel/logo.svg`, monta o logotipo com tipografia --
 * geometrica, o `.inc` em italico e EMBRALOT em peso leve, como no timbrado.
 */
export function marca(fonte = null) {
  if (fonte) {
    return `<img class="marca__logo" src="${fonte}" alt="ABC.inc &amp; EMBRALOT">`;
  }
  return `<span class="marca__abc">ABC<span class="marca__inc">.inc</span></span>
      <span class="marca__e">&amp;</span>
      <span class="marca__embralot">EMBRALOT</span>`;
}

/** Faixa creme do cabecalho, igual a do papel timbrado. */
export function timbre({ logo = null, direita = '' } = {}) {
  return `<div class="timbre">
    <div class="timbre__interno">
      <div class="marca">${marca(logo)}</div>
      ${direita || `<span class="assinatura">${SITE}</span>`}
    </div>
  </div>`;
}
