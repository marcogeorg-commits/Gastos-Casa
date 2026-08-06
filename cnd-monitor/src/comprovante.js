/**
 * O documento em si, guardado em disco.
 *
 * O relatorio diz que a certidao esta negativa; o comprovante e o que se anexa
 * numa licitacao ou se manda para o banco. Sem ele o sistema informa e nao
 * entrega -- e a pessoa acaba refazendo a consulta a mao so para ter o papel.
 *
 * Cada portal devolve de um jeito: o CNDT forca download de PDF, a Receita
 * mostra a certidao como pagina. Por isso a captura tenta, em ordem:
 *
 *   1. o arquivo que o portal baixou, se baixou;
 *   2. a pagina impressa em PDF;
 *   3. a tela e o HTML, quando nem isso for possivel.
 *
 * O terceiro caso nao e desistencia: uma captura de tela da certidao ainda
 * prova o que foi consultado e quando, e e melhor que registro nenhum.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Nome de pasta a partir da razao social.
 *
 * Barras e dois-pontos quebram caminho no macOS e no Windows; acento e espaco
 * atrapalham em anexo de e-mail. Some tudo, sem inventar nome novo.
 */
export function comoPasta(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .toUpperCase();
}

/**
 * Onde o comprovante deste cliente e desta competencia vai morar.
 *
 * Uma pasta por cliente dentro de uma pasta por competencia: e assim que quem
 * usa procura -- "os documentos da Alfa em agosto" --, e nao por tipo de
 * certidao.
 */
export function caminhoDoComprovante({ raiz, competencia, cliente, idCertidao, extensao = 'pdf' }) {
  const documento = String(cliente.documento ?? '').replace(/\D/g, '');
  const pasta = resolve(
    raiz,
    'certidoes',
    String(competencia),
    `${documento}_${comoPasta(cliente.nome)}`,
  );
  return { pasta, arquivo: resolve(pasta, `${idCertidao.toUpperCase()}.${extensao}`) };
}

/**
 * Guarda o comprovante e devolve o caminho relativo, ou null.
 *
 * Nunca lanca: ficar sem o arquivo e ruim, mas perder o resultado da consulta
 * por causa disso seria pior -- a informacao de que o cliente esta irregular
 * vale mesmo sem o papel.
 */
export async function salvarComprovante({ pagina, download, raiz, competencia, cliente, idCertidao }) {
  const guardar = async (extensao) => {
    const { pasta, arquivo } = caminhoDoComprovante({
      raiz,
      competencia,
      cliente,
      idCertidao,
      extensao,
    });
    await mkdir(pasta, { recursive: true });
    return arquivo;
  };

  const relativo = (caminho) => caminho.slice(resolve(raiz).length + 1);

  // 1. O portal baixou o arquivo (CNDT faz assim).
  if (download) {
    try {
      const destino = await guardar('pdf');
      await download.saveAs(destino);
      return relativo(destino);
    } catch {
      // Cai para as proximas formas.
    }
  }

  if (!pagina) return null;

  // 2. A certidao esta na tela: imprime em PDF.
  try {
    const destino = await guardar('pdf');
    await pagina.pdf({ path: destino, format: 'A4', printBackground: true });
    return relativo(destino);
  } catch {
    // `page.pdf()` so funciona em Chromium sem janela. No modo assistido, que
    // roda com janela aberta de proposito, ele falha -- e ai a tela serve.
  }

  // 3. Nem download nem PDF: guarda a tela e o HTML.
  try {
    const destino = await guardar('png');
    await pagina.screenshot({ path: destino, fullPage: true });
    await writeFile(
      destino.replace(/\.png$/, '.html'),
      await pagina.content().catch(() => ''),
      'utf8',
    );
    return relativo(destino);
  } catch {
    return null;
  }
}
