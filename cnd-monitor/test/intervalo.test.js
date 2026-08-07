import test from 'node:test';
import assert from 'node:assert/strict';

import { esperarContando, executar, proximoIntervalo } from '../src/executor.js';

/**
 * Vinte e dois clientes disparados em sequência, sem respiro, é o que faz um
 * portal público responder "tente novamente dentro de alguns minutos" — e
 * depois disso a rodada inteira se perde, não só a consulta que passou do
 * limite.
 */
test('o intervalo nunca é menor que o pedido', () => {
  // Piso no que foi pedido: aleatório para menos seria pedir 20s e bater em 12.
  assert.equal(proximoIntervalo(20_000, () => 0), 20_000);
  assert.equal(proximoIntervalo(20_000, () => 1), 28_000);
  assert.ok(proximoIntervalo(20_000, () => 0.5) > 20_000);

  // Sem intervalo pedido, não há espera nenhuma.
  assert.equal(proximoIntervalo(0), 0);
  assert.equal(proximoIntervalo(undefined), 0);
});

test('a contagem aparece na tela a cada segundo', async () => {
  const ditos = [];
  // Sem dormir de verdade: o que se testa é a contagem, não o relógio.
  await esperarContando(3000, (m) => ditos.push(m), async () => {});

  assert.equal(ditos.length, 3, 'um aviso por segundo');
  assert.match(ditos[0], /aguardando 3s/);
  assert.match(ditos.at(-1), /aguardando 1s/);
});

test('não há contagem quando não há espera', async () => {
  const ditos = [];
  await esperarContando(0, (m) => ditos.push(m), async () => {});
  assert.deepEqual(ditos, []);
});

const CADASTRO = {
  provedorPadrao: 'mock',
  provedores: {},
  certidoes: ['rfb_pgfn'],
  avisos: [],
  // `certidoes` por cliente: e assim que o executor recebe o cadastro, ja
  // resolvido pela config -- ele nao herda da raiz sozinho.
  clientes: [
    { nome: 'Alfa', documento: '11222333000181', documentoFormatado: '11.222.333/0001-81', tipo: 'cnpj', certidoes: ['rfb_pgfn'] },
    { nome: 'Beta', documento: '22333444000181', documentoFormatado: '22.333.444/0001-81', tipo: 'cnpj', certidoes: ['rfb_pgfn'] },
    { nome: 'Gama', documento: '33444555000181', documentoFormatado: '33.444.555/0001-81', tipo: 'cnpj', certidoes: ['rfb_pgfn'] },
  ],
};

test('espera entre uma consulta e a seguinte, mas não antes da primeira', async () => {
  const eventos = [];

  await executar(
    { ...CADASTRO },
    {},
    {
      concorrencia: 1,
      intervalo: 2000,
      env: {},
      // Ninguém quer esperar para começar: a pausa é entre, não antes.
      registrar: (m) => eventos.push(m),
      aoProgredir: () => eventos.push('CONSULTOU'),
    },
  );

  const consultas = eventos.filter((e) => e === 'CONSULTOU').length;
  assert.equal(consultas, 3);

  // A primeira coisa que acontece é uma consulta, não uma espera.
  assert.equal(eventos[0], 'CONSULTOU');
  // E houve espera entre as três: duas pausas para três clientes.
  const pausas = eventos.filter((e) => /aguardando/.test(e));
  assert.ok(pausas.length > 0, 'contou a espera na tela');
});

test('sem intervalo, a rodada não espera nada', async () => {
  const eventos = [];

  await executar({ ...CADASTRO }, {}, {
    concorrencia: 1,
    env: {},
    registrar: (m) => eventos.push(m),
  });

  assert.deepEqual(
    eventos.filter((e) => /aguardando/.test(e)),
    [],
  );
});
