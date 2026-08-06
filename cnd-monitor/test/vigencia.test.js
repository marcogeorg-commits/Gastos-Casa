import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { carregarVigentes, comoData, diasAte } from '../src/vigencia.js';

const HOJE = new Date('2026-08-06T12:00:00Z');

test('lê a data como o portal escreve e como o histórico guarda', () => {
  // Os portais escrevem dd/mm/aaaa; o histórico guarda aaaa-mm-dd. Ler só um
  // formato faria o cache errar sempre para metade das certidões.
  assert.equal(comoData('31/12/2026'), '2026-12-31');
  assert.equal(comoData('2026-12-31'), '2026-12-31');
  assert.equal(comoData('2026-12-31T00:00:00Z'), '2026-12-31');
  assert.equal(comoData('mês que vem'), null);
});

test('conta os dias até o vencimento, e para trás quando já passou', () => {
  assert.equal(diasAte('06/08/2026', HOJE), 0);
  assert.equal(diasAte('16/08/2026', HOJE), 10);
  assert.equal(diasAte('01/08/2026', HOJE), -5);
  assert.equal(diasAte(null, HOJE), null);
});

async function historicoCom(resultados, nome = '2026-07.json') {
  const pasta = await mkdtemp(join(tmpdir(), 'vig-'));
  await writeFile(join(pasta, nome), JSON.stringify({ resultados }));
  return pasta;
}

const item = (extra) => ({
  documento: '11222333000181',
  certidao: 'rfb_pgfn',
  situacao: 'negativa',
  ...extra,
});

test('certidão com validade folgada é aproveitada', async () => {
  const pasta = await historicoCom([item({ validaAte: '31/12/2026' })]);
  const vigentes = await carregarVigentes(pasta, { hoje: HOJE });

  const achado = vigentes.get('11222333000181|rfb_pgfn');
  assert.ok(achado, 'devia estar vigente');
  assert.equal(achado.diasRestantes, 147);
  assert.equal(achado.origem, '2026-07');
});

test('certidão que vence logo é refeita, apesar de ainda valer', async () => {
  // Aproveitar uma que vence em 5 dias entregaria ao cliente um documento
  // prestes a expirar — o banco recusa e o trabalho volta.
  const pasta = await historicoCom([item({ validaAte: '11/08/2026' })]);
  const vigentes = await carregarVigentes(pasta, { hoje: HOJE });
  assert.equal(vigentes.size, 0);
});

test('certidão vencida nunca é aproveitada', async () => {
  const pasta = await historicoCom([item({ validaAte: '01/01/2026' })]);
  assert.equal((await carregarVigentes(pasta, { hoje: HOJE })).size, 0);
});

test('resultado sem validade não vira cache', async () => {
  // Falha de consulta e conferência manual não têm validade. Tratá-las como
  // vigentes esconderia para sempre uma certidão que nunca foi emitida.
  const pasta = await historicoCom([
    item({ situacao: 'erro', validaAte: null }),
    item({ certidao: 'cndt', situacao: 'manual' }),
  ]);
  assert.equal((await carregarVigentes(pasta, { hoje: HOJE })).size, 0);
});

test('vale a consulta mais recente, não a primeira encontrada', async () => {
  const pasta = await mkdtemp(join(tmpdir(), 'vig-'));
  await writeFile(
    join(pasta, '2026-06.json'),
    JSON.stringify({ resultados: [item({ validaAte: '31/12/2026', numeroCertidao: 'ANTIGA' })] }),
  );
  await writeFile(
    join(pasta, '2026-07.json'),
    JSON.stringify({ resultados: [item({ validaAte: '31/12/2026', numeroCertidao: 'NOVA' })] }),
  );

  const vigentes = await carregarVigentes(pasta, { hoje: HOJE });
  assert.equal(vigentes.get('11222333000181|rfb_pgfn').numeroCertidao, 'NOVA');
});

test('histórico ilegível não derruba o aproveitamento das outras', async () => {
  const pasta = await historicoCom([item({ validaAte: '31/12/2026' })]);
  await writeFile(join(pasta, '2026-08.json'), '{ isto não é json');

  const vigentes = await carregarVigentes(pasta, { hoje: HOJE });
  assert.equal(vigentes.size, 1);
});

test('o documento formatado do histórico casa com o limpo da rodada', async () => {
  const { chaveDe } = await import('../src/vigencia.js');

  // O histórico grava "11.222.333/0001-81"; a rodada trabalha com
  // "11222333000181". Comparados como vêm, o cache nunca casava com dado real
  // — e falhava em silêncio, reconsultando tudo, sem ninguém perceber.
  const pasta = await historicoCom([
    { documento: '11.222.333/0001-81', certidao: 'rfb_pgfn', validaAte: '31/12/2026' },
  ]);

  const vigentes = await carregarVigentes(pasta, { hoje: HOJE });
  assert.ok(vigentes.get(chaveDe('11222333000181', 'rfb_pgfn')), 'devia casar apesar da máscara');
});

test('sem histórico, não há o que aproveitar', async () => {
  assert.equal((await carregarVigentes('/pasta/que/nao/existe')).size, 0);
});
