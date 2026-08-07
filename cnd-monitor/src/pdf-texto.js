/**
 * Texto de dentro do PDF da certidão.
 *
 * A resposta não está na página do portal: está no documento. A tela só diz
 * "A certidão foi emitida com sucesso" -- a mesma frase para certidão negativa
 * e para positiva com efeito de negativa, que são coisas diferentes para quem
 * presta contas. Quem sabe qual é, é o PDF.
 *
 * E o PDF já estava sendo baixado e jogado fora: quando a leitura da página
 * falhava, a consulta virava erro e o comprovante ia junto.
 *
 * Não é um leitor de PDF completo, e não pretende ser. Ele pega o caso que
 * interessa: certidão de portal de governo, texto em fluxos deflate, fonte com
 * codificação deslocada. Quando não consegue ler, diz que não conseguiu -- o
 * arquivo fica salvo e a consulta pede olho humano. Nunca chuta.
 */

import { inflateSync } from 'node:zlib';

/** Fluxos de conteúdo do arquivo, já descomprimidos quando dá. */
function fluxos(bytes) {
  const achados = [];
  const marcaInicio = Buffer.from('stream');
  const marcaFim = Buffer.from('endstream');

  let de = 0;
  while (de < bytes.length) {
    const inicio = bytes.indexOf(marcaInicio, de);
    if (inicio < 0) break;
    const fim = bytes.indexOf(marcaFim, inicio);
    if (fim < 0) break;

    // Pula o "stream" e a quebra de linha que o segue.
    let corpo = bytes.subarray(inicio + marcaInicio.length, fim);
    if (corpo[0] === 0x0d) corpo = corpo.subarray(1);
    if (corpo[0] === 0x0a) corpo = corpo.subarray(1);

    try {
      achados.push(inflateSync(corpo));
    } catch {
      // Fluxo de imagem, ou compressão que não é deflate: não é texto.
    }
    de = fim + marcaFim.length;
  }
  return achados;
}

/** Os literais de texto de um fluxo de conteúdo, na ordem em que aparecem. */
function literais(fluxo) {
  const texto = fluxo.toString('latin1');
  const pedacos = [];

  // `(...)` com escapes; `Tj` e `TJ` desenham o que está neles.
  for (const achado of texto.matchAll(/\((?:\\.|[^\\()])*\)/gs)) {
    pedacos.push(
      achado[0]
        .slice(1, -1)
        .replace(/\\([nrtbf])/g, ' ')
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))),
    );
  }
  return pedacos;
}

/**
 * A fonte pode usar codificação própria, deslocada da tabela usual.
 *
 * No PDF da Receita as letras vêm 29 posições abaixo do ASCII: "CERTIDÃO"
 * chega como "&(57,'­2". O deslocamento é da fonte, não do formato, então não
 * dá para presumir -- mas dá para descobrir: aplica-se cada candidato e
 * aceita-se o que produzir palavras que uma certidão tem.
 */
// Só palavras sem acento: o deslocamento acerta as letras comuns e erra as
// acentuadas, que vêm de outra faixa da tabela. "CERTIDÃO" deslocada vira
// "CERTIDÊO" -- exigir o "Ã" faria a prova falhar justamente no texto certo.
const PROVA = /CERTID|RECEITA FEDERAL|FAZENDA NACIONAL|TRIBUTOS FEDERAIS|NEGATIVA/i;

/**
 * O texto ja esta legivel?
 *
 * Sem esta pergunta, qualquer PDF que nao fosse certidao era recusado como
 * "nao deu para ler" -- mesmo quando a leitura tinha funcionado perfeitamente e
 * o problema era outro: nao era certidao. Sao coisas diferentes, e so a
 * segunda o operador consegue resolver.
 *
 * O criterio e a proporcao de caracteres que uma frase em portugues tem.
 */
export function pareceTexto(s) {
  const amostra = String(s ?? '').slice(0, 2000);
  if (amostra.length < 20) return false;

  const legiveis = (amostra.match(/[A-Za-zÀ-ÿ0-9 .,:;/()-]/g) ?? []).length;
  return legiveis / amostra.length > 0.85;
}

export function corrigirDeslocamento(bruto) {
  if (PROVA.test(bruto) || pareceTexto(bruto)) return { texto: bruto, deslocamento: 0 };

  for (let d = 1; d <= 64; d += 1) {
    // Inclui os controles: o espaco vem como 0x03 e, sem desloca-lo tambem, as
    // palavras chegam coladas -- e frase colada nao casa com "nao constam
    // pendencias", que e o que decide a situacao.
    const tentativa = bruto.replace(/[\s\S]/g, (c) =>
      String.fromCharCode((c.charCodeAt(0) + d) & 0xff),
    );
    if (PROVA.test(tentativa)) return { texto: tentativa, deslocamento: d };
  }
  return null;
}

/**
 * Junta o texto e devolve legível, ou `null` se não deu para ler.
 *
 * Devolver `null` é deliberado: uma certidão mal lida vira um "negativa" que
 * ninguém conferiu. Melhor dizer que não leu e deixar o arquivo salvo.
 */
export function extrairTextoPdf(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length === 0) return null;

  // O texto vem em UTF-16: cada letra precedida de um byte zero. Sem tirar os
  // zeros, o deslocamento cai sobre eles e nada casa.
  const bruto = fluxos(buffer).flatMap(literais).join('').replace(/\u0000/g, '');
  if (!bruto) return null;

  const corrigido = corrigirDeslocamento(bruto);
  if (!corrigido) return null;

  return corrigido.texto.replace(/\s+/g, ' ').trim();
}
