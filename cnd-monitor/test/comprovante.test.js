import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { caminhoDoComprovante, comoPasta, salvarComprovante } from '../src/comprovante.js';

const cliente = { nome: 'Alfa Comércio de Alimentos Ltda', documento: '11.222.333/0001-81' };

test('o nome da pasta sobrevive a acento, barra e espaço', () => {
  // Barra quebra caminho; acento atrapalha em anexo de e-mail e em outro
  // sistema de arquivos.
  assert.equal(comoPasta('Alfa Comércio de Alimentos Ltda'), 'ALFA_COMERCIO_DE_ALIMENTOS_LTDA');
  assert.equal(comoPasta('Delta Indústria Têxtil S/A'), 'DELTA_INDUSTRIA_TEXTIL_S_A');
  assert.equal(comoPasta(''), '');
});

test('o comprovante é arquivado por competência e por cliente', () => {
  const { arquivo } = caminhoDoComprovante({
    raiz: '/projeto',
    competencia: '2026-08',
    cliente,
    idCertidao: 'rfb_pgfn',
  });

  // É assim que se procura: "os documentos da Alfa em agosto".
  assert.equal(
    arquivo,
    '/projeto/certidoes/2026-08/11222333000181_ALFA_COMERCIO_DE_ALIMENTOS_LTDA/RFB_PGFN.pdf',
  );
});

test('o download do portal é o que vale, quando existe', async () => {
  const raiz = await mkdtemp(join(tmpdir(), 'comp-'));
  let salvoEm = null;

  const download = {
    saveAs: async (destino) => {
      salvoEm = destino;
      await (await import('node:fs/promises')).writeFile(destino, '%PDF-falso');
    },
  };

  const relativo = await salvarComprovante({
    pagina: null,
    download,
    raiz,
    competencia: '2026-08',
    cliente,
    idCertidao: 'cndt',
  });

  assert.match(relativo, /^certidoes\/2026-08\/.*\/CNDT\.pdf$/);
  assert.equal(await readFile(salvoEm, 'utf8'), '%PDF-falso');
});

test('sem download, imprime a página em PDF', async () => {
  const raiz = await mkdtemp(join(tmpdir(), 'comp-'));
  const pagina = {
    pdf: async ({ path }) => (await import('node:fs/promises')).writeFile(path, '%PDF-impresso'),
  };

  const relativo = await salvarComprovante({
    pagina,
    download: null,
    raiz,
    competencia: '2026-08',
    cliente,
    idCertidao: 'rfb_pgfn',
  });

  assert.match(relativo, /RFB_PGFN\.pdf$/);
  assert.ok((await stat(join(raiz, relativo))).isFile());
});

test('quando o PDF não é possível, guarda a tela e o HTML', async () => {
  const raiz = await mkdtemp(join(tmpdir(), 'comp-'));

  // `page.pdf()` só funciona em Chromium sem janela — e o modo assistido roda
  // com janela de propósito. Nesse caso a captura de tela ainda prova o que
  // foi consultado; é melhor que registro nenhum.
  const pagina = {
    pdf: async () => {
      throw new Error('PDF generation is only supported in headless mode');
    },
    screenshot: async ({ path }) =>
      (await import('node:fs/promises')).writeFile(path, 'PNG-falso'),
    content: async () => '<html>certidão</html>',
  };

  const relativo = await salvarComprovante({
    pagina,
    download: null,
    raiz,
    competencia: '2026-08',
    cliente,
    idCertidao: 'cndt',
  });

  assert.match(relativo, /CNDT\.png$/);
  assert.equal(await readFile(join(raiz, relativo.replace('.png', '.html')), 'utf8'),
    '<html>certidão</html>');
});

test('falhar ao guardar não derruba a consulta', async () => {
  // Ficar sem o arquivo é ruim; perder o resultado da consulta por causa disso
  // seria pior — saber que o cliente está irregular vale mesmo sem o papel.
  const pagina = {
    pdf: async () => { throw new Error('sem PDF'); },
    screenshot: async () => { throw new Error('sem tela'); },
    content: async () => '',
  };

  const relativo = await salvarComprovante({
    pagina,
    download: null,
    raiz: await mkdtemp(join(tmpdir(), 'comp-')),
    competencia: '2026-08',
    cliente,
    idCertidao: 'cndt',
  });

  assert.equal(relativo, null);
});
