import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  competenciaDe,
  examinar,
  expandir,
  extrairDocumento,
  gravarNoHistorico,
  importar,
  reconhecerCertidao,
} from '../src/importar.js';

/**
 * PDF como os portais de governo entregam: texto em fluxo comprimido, em
 * UTF-16, e fonte com codificacao deslocada.
 *
 * O separador entre as letras e o byte nulo do UTF-16, escrito por extenso de
 * proposito: na primeira versao ele estava no arquivo como byte cru,
 * invisivel. Reescrever o mesmo helper com um espaco no lugar produzia
 * "C=E=R=T=I=D" -- ilegivel, e sem nada na tela explicando por que.
 */
function pdfFalso(texto, deslocamento = 29) {
  const deslocado = [...texto]
    .map((c) => String.fromCharCode((c.charCodeAt(0) - deslocamento) & 0xff))
    .map((c) => `\u0000${c}`)
    .join('');
  const escapado = deslocado.replace(/[()\\]/g, (c) => `\\${c}`);
  const fluxo = deflateSync(Buffer.from(`BT (${escapado}) Tj ET`, 'latin1'));

  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nstream\n', 'latin1'),
    fluxo,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
}

const CND_FEDERAL =
  'MINISTERIO DA FAZENDA Secretaria da Receita Federal do Brasil ' +
  'Procuradoria-Geral da Fazenda Nacional CERTIDAO NEGATIVA DE DEBITOS RELATIVOS AOS ' +
  'TRIBUTOS FEDERAIS E A DIVIDA ATIVA DA UNIAO Nome: ALFA COMERCIO LTDA ' +
  'CNPJ: 11.222.333/0001-81 e certificado que nao constam pendencias em seu nome. ' +
  'Esta certidao e valida ate 02/02/2027.';

test('reconhece a certidão pelo que está escrito nela, não pelo nome do arquivo', () => {
  // Deduzir do nome do arquivo é o erro que já custou caro nos certificados.
  assert.equal(reconhecerCertidao(CND_FEDERAL), 'rfb_pgfn');
  assert.equal(
    reconhecerCertidao('CERTIDAO NEGATIVA DE DEBITOS TRABALHISTAS Tribunal Superior do Trabalho'),
    'cndt',
  );
  assert.equal(reconhecerCertidao('Certificado de Regularidade do FGTS Caixa Economica'), 'fgts_crf');
  assert.equal(reconhecerCertidao('um texto qualquer'), null);
});

test('lê o documento do titular de dentro da certidão', () => {
  assert.equal(extrairDocumento('CNPJ: 11.222.333/0001-81'), '11222333000181');
  assert.equal(extrairDocumento('CPF: 123.456.780-62'), '12345678062');
  // Sem rótulo, o formato de CNPJ ainda é reconhecível.
  assert.equal(extrairDocumento('emitida para 11.222.333/0001-81 em 01/01'), '11222333000181');
  assert.equal(extrairDocumento('nenhum documento aqui'), null);
});

test('examina o PDF inteiro: de quem é, qual é, como está e até quando vale', async () => {
  const pasta = await mkdtemp(join(tmpdir(), 'cnd-imp-'));
  const arquivo = join(pasta, 'certidao.pdf');
  await writeFile(arquivo, pdfFalso(CND_FEDERAL));

  const r = await examinar(arquivo);

  assert.equal(r.documento, '11222333000181');
  assert.equal(r.idCertidao, 'rfb_pgfn');
  assert.equal(r.situacao, 'negativa');
  assert.equal(r.validaAte, '02/02/2027');
});

/**
 * Ruido e problema sao coisas diferentes.
 *
 * Apontar a pasta de Downloads de um escritorio e receber duzentas linhas de
 * falha esconde as duas certidoes que estavam la no meio. Balancete nao e
 * falha; e balancete. So o que E certidao e nao entrou vira problema.
 */
test('o que não é certidão é ignorado; o que é certidão e falha vira problema', async () => {
  const pasta = await mkdtemp(join(tmpdir(), 'cnd-imp-'));

  const naoPdf = join(pasta, 'planilha.xlsx');
  await writeFile(naoPdf, 'qualquer coisa');
  assert.match((await examinar(naoPdf)).ignorado, /não é um PDF/);

  // Digitalizacao: o texto nao sai. Nao e falha do programa nem do operador.
  const digitalizado = join(pasta, 'scan.pdf');
  await writeFile(digitalizado, '%PDF-1.4 sem fluxo nenhum');
  assert.match((await examinar(digitalizado)).ignorado, /digitalização|texto/);

  const balancete = join(pasta, 'balancete.pdf');
  await writeFile(balancete, pdfFalso('BALANCETE Prefeitura Municipal CNPJ: 11.222.333/0001-81', 0));
  assert.match((await examinar(balancete)).ignorado, /não é uma certidão/);

  // Ja isto E certidao e nao entrou: o operador precisa saber.
  const semDocumento = join(pasta, 'certidao.pdf');
  await writeFile(semDocumento, pdfFalso('CERTIDAO NEGATIVA DE DEBITOS TRABALHISTAS Tribunal Superior do Trabalho', 0));
  const r = await examinar(semDocumento);
  assert.equal(r.ignorado, undefined);
  assert.match(r.erro, /é certidão, mas não achei CNPJ/);
});

/**
 * "Santa Catarina" numa proposta comercial virava certidao da SEFAZ/SC, e
 * "Prefeitura" num balancete virava certidao municipal. Com o CNPJ no cadastro,
 * o arquivo teria sido guardado como certidao do cliente -- e o relatorio
 * passaria a afirmar, com documento anexado, uma situacao que ninguem apurou.
 */
test('nome de estado ou de órgão, sozinho, não faz uma certidão', async () => {
  const { pareceCertidao } = await import('../src/importar.js');

  assert.equal(reconhecerCertidao('PROPOSTA DE HONORARIOS ... Santa Catarina ... CNPJ: 1'), null);
  assert.equal(reconhecerCertidao('BALANCETE Prefeitura Municipal de Blumenau'), null);
  assert.equal(reconhecerCertidao('Nota fiscal emitida em Santa Catarina'), null);

  // E o que e certidao de verdade continua sendo reconhecido.
  assert.equal(
    reconhecerCertidao('CERTIDAO NEGATIVA Secretaria de Estado da Fazenda de Santa Catarina'),
    'sefaz_sc',
  );
  assert.equal(
    reconhecerCertidao('Certificado de Regularidade do FGTS Caixa Economica Federal'),
    'fgts_crf',
  );

  assert.equal(pareceCertidao('uma proposta comercial'), false);
  assert.equal(pareceCertidao('CERTIDÃO NEGATIVA'), true);
});

async function raizDeTeste() {
  const raiz = await mkdtemp(join(tmpdir(), 'cnd-raiz-'));
  await mkdir(join(raiz, 'entrada'), { recursive: true });
  return raiz;
}

const CONFIG = {
  clientes: [{ nome: 'Alfa Comércio Ltda', documento: '11222333000181', tipo: 'cnpj' }],
};

test('arquiva por cliente e competência, e grava no histórico', async () => {
  const raiz = await raizDeTeste();
  await writeFile(join(raiz, 'entrada', 'baixada.pdf'), pdfFalso(CND_FEDERAL));

  const { importados, historico } = await importar([join(raiz, 'entrada')], {
    raiz,
    config: CONFIG,
    competencia: '2026-08',
  });

  assert.equal(importados.length, 1);
  assert.equal(importados[0].erro, undefined);
  assert.match(importados[0].arquivo, /certidoes\/2026-08\/11222333000181_ALFA/);
  assert.match(importados[0].arquivo, /RFB_PGFN\.pdf$/i);

  // O PDF chega inteiro, byte a byte: é o documento que vai para o banco.
  assert.deepEqual(
    await readFile(importados[0].arquivo),
    await readFile(join(raiz, 'entrada', 'baixada.pdf')),
  );

  const gravado = JSON.parse(await readFile(historico, 'utf8'));
  const linha = gravado.resultados[0];
  assert.equal(linha.situacao, 'negativa');
  assert.equal(linha.validaAte, '02/02/2027');
  assert.equal(linha.origem, 'importada');
  // A origem fica registrada: o relatório não pode dar a entender que o
  // programa emitiu o que uma pessoa emitiu à mão.
  assert.match(linha.detalhe, /à mão/);
});

test('reimportar corrige, não duplica', async () => {
  const raiz = await raizDeTeste();
  await writeFile(join(raiz, 'entrada', 'a.pdf'), pdfFalso(CND_FEDERAL));

  const opcoes = { raiz, config: CONFIG, competencia: '2026-08' };
  await importar([join(raiz, 'entrada')], opcoes);
  const { historico } = await importar([join(raiz, 'entrada')], opcoes);

  const gravado = JSON.parse(await readFile(historico, 'utf8'));
  // Duas linhas do mesmo cliente e certidão deixariam o relatório com dois
  // desfechos e nenhum jeito de saber qual vale.
  assert.equal(gravado.resultados.length, 1);
});

test('cliente fora do cadastro é recusado, não arquivado em outro', async () => {
  const raiz = await raizDeTeste();
  await writeFile(join(raiz, 'entrada', 'estranho.pdf'), pdfFalso(CND_FEDERAL));

  const { importados, historico } = await importar([join(raiz, 'entrada')], {
    raiz,
    config: { clientes: [{ nome: 'Beta', documento: '22333444000181' }] },
    competencia: '2026-08',
  });

  // Arquivar no cliente errado é pior que não arquivar.
  assert.match(importados[0].erro, /não está no cadastro/);
  assert.equal(historico, null, 'nada foi gravado');
});

test('a pasta inteira vale, e só os PDFs dela', async () => {
  const raiz = await raizDeTeste();
  await writeFile(join(raiz, 'entrada', 'a.pdf'), 'x');
  await writeFile(join(raiz, 'entrada', 'b.PDF'), 'x');
  await writeFile(join(raiz, 'entrada', 'nota.txt'), 'x');

  const achados = await expandir([join(raiz, 'entrada')]);
  assert.equal(achados.length, 2);
  assert.ok(achados.every((a) => /\.pdf$/i.test(a)));

  // Caminho que não existe não derruba a rodada.
  assert.deepEqual(await expandir([join(raiz, 'nao-existe')]), []);
});

test('sem nada importado, o histórico não é tocado', async () => {
  const raiz = await raizDeTeste();
  assert.equal(await gravarNoHistorico([{ erro: 'x' }], { raiz, competencia: '2026-08' }), null);
});

test('a competência é a do mês', () => {
  assert.equal(competenciaDe(new Date('2026-08-07T12:00:00Z')), '2026-08');
  assert.equal(competenciaDe(new Date('2026-01-31T23:00:00Z')), '2026-01');
});

test('o trecho guardado comeca na certidao, nao no lixo da fonte', async () => {
  const { trecho } = await import('../src/importar.js');

  // O PDF traz fluxos que nao sao texto -- fontes, sobretudo -- e eles saem da
  // extracao como ruido. Guardar isso no historico nao prova nada a ninguem.
  const sujo = 'PZNT MINISTERIO DA FAZENDA CERTIDAO NEGATIVA CNPJ: 11.222.333/0001-81';
  const limpo = trecho(sujo);

  assert.ok(limpo.startsWith('MINISTERIO'), `comecou com "${limpo.slice(0, 20)}"`);
  assert.match(limpo, /CNPJ: 11\.222\.333\/0001-81/);

  assert.equal(trecho('texto sem titulo nenhum'), 'texto sem titulo nenhum');
  assert.equal(trecho(null), '');
});
