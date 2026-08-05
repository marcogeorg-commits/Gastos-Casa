import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  carregarAnterior,
  compararComAnterior,
  descreverMudanca,
  gravidade,
  listarCompetencias,
} from '../src/historico.js';

const item = (documento, certidao, situacao, cliente = 'Alfa Ltda') => ({
  cliente,
  documento,
  certidao,
  certidaoNome: 'CND Federal',
  situacao,
});

async function historicoTemporario(competencias) {
  const pasta = await mkdtemp(join(tmpdir(), 'hist-'));
  for (const [competencia, resultados] of Object.entries(competencias)) {
    await writeFile(
      join(pasta, `${competencia}.json`),
      JSON.stringify({ competencia, resultados }),
      'utf8',
    );
  }
  return pasta;
}

test('lista competências em ordem, ignorando outros arquivos', async () => {
  const pasta = await historicoTemporario({ '2026-07': [], '2026-06': [], '2026-08': [] });
  await writeFile(join(pasta, 'teste.json'), '{}', 'utf8');

  assert.deepEqual(await listarCompetencias(pasta), ['2026-06', '2026-07', '2026-08']);
});

test('anterior é a última execução real, não o mês calendário anterior', async () => {
  // Se a rotina não rodou em julho, comparar com junho ainda é útil.
  const pasta = await historicoTemporario({ '2026-04': [], '2026-06': [] });
  const anterior = await carregarAnterior(pasta, '2026-08');

  assert.equal(anterior.competencia, '2026-06');
});

test('histórico vazio não quebra a primeira execução', async () => {
  const pasta = await historicoTemporario({});

  assert.equal(await carregarAnterior(pasta, '2026-08'), null);
  assert.equal(compararComAnterior([item('A', 'rfb_pgfn', 'negativa')], null), null);
});

test('quem virou devedor aparece como piora, no topo', () => {
  const anterior = {
    competencia: '2026-07',
    resultados: [
      item('A', 'rfb_pgfn', 'negativa'),
      item('B', 'rfb_pgfn', 'positiva', 'Beta Ltda'),
      item('C', 'rfb_pgfn', 'negativa', 'Gama Ltda'),
    ],
  };
  const atual = [
    item('A', 'rfb_pgfn', 'positiva'), // piorou
    item('B', 'rfb_pgfn', 'negativa', 'Beta Ltda'), // melhorou
    item('C', 'rfb_pgfn', 'negativa', 'Gama Ltda'), // igual
  ];

  const c = compararComAnterior(atual, anterior);

  assert.equal(c.mudancas.length, 2, 'quem não mudou fica fora');
  assert.equal(c.mudancas[0].tipo, 'piorou', 'a piora vem primeiro');
  assert.equal(c.mudancas[0].atual.documento, 'A');
  assert.equal(c.mudancas[1].tipo, 'melhorou');
  assert.equal(c.pioraram, 1);
  assert.equal(c.melhoraram, 1);
});

test('"não emitida" pesa como positiva — a transição entre elas não é piora', () => {
  assert.equal(gravidade('nao_emitida'), gravidade('positiva'));

  const c = compararComAnterior(
    [item('A', 'rfb_pgfn', 'nao_emitida')],
    { competencia: '2026-07', resultados: [item('A', 'rfb_pgfn', 'positiva')] },
  );

  assert.equal(c.mudancas[0].tipo, 'mudou');
});

test('falha de consulta não é lida como regularização', () => {
  // Portal fora do ar não pode virar boa notícia.
  const c = compararComAnterior(
    [item('A', 'rfb_pgfn', 'erro')],
    { competencia: '2026-07', resultados: [item('A', 'rfb_pgfn', 'negativa')] },
  );

  assert.equal(c.mudancas[0].tipo, 'piorou');
});

test('entradas e saídas do cadastro contam como mudança', () => {
  const c = compararComAnterior(
    [item('A', 'rfb_pgfn', 'negativa'), item('NOVO', 'rfb_pgfn', 'positiva', 'Delta Ltda')],
    {
      competencia: '2026-07',
      resultados: [item('A', 'rfb_pgfn', 'negativa'), item('SAIU', 'rfb_pgfn', 'negativa', 'Zeta Ltda')],
    },
  );

  const tipos = c.mudancas.map((m) => m.tipo);
  assert.deepEqual(tipos, ['novo', 'removido']);
  assert.match(descreverMudanca(c.mudancas[0]), /passou a ser monitorada/);
  assert.match(descreverMudanca(c.mudancas[1]), /saiu do monitoramento/);
});

test('a transição é descrita em português, não em códigos', () => {
  const mudanca = {
    tipo: 'piorou',
    anterior: item('A', 'rfb_pgfn', 'negativa'),
    atual: item('A', 'rfb_pgfn', 'nao_emitida'),
  };

  assert.equal(descreverMudanca(mudanca), 'Negativa → Não emitida — há pendências a regularizar');
});

test('rodada avulsa não é comparada com competência real', async () => {
  // `--competencia teste` roda com um cadastro reduzido. Compará-la com agosto
  // apontava dezenas de "clientes removidos" que nunca saíram de lugar nenhum.
  const pasta = await historicoTemporario({ '2026-08': [item('A', 'rfb_pgfn', 'negativa')] });

  assert.equal(await carregarAnterior(pasta, 'teste'), null);
  assert.equal(await carregarAnterior(pasta, 'homologacao'), null);
  assert.notEqual(await carregarAnterior(pasta, '2026-09'), null);
});
