import test from 'node:test';
import assert from 'node:assert/strict';

import { deixarLer } from '../src/provedores/assistido.js';

/**
 * A janela sumia levando junto o motivo da falha.
 *
 * Quando a consulta não dá certo, o portal escreve o porquê na própria página
 * — e a janela fechava logo em seguida. O operador via um erro passar e ficava
 * sem saber o que dizia. Foi o que aconteceu com o aviso 023 da Receita.
 */
const paginaFalsa = (fechada = false) => ({
  isClosed: () => fechada,
});

test('quando deu errado, a janela espera o operador ler', async () => {
  const janela = { fechada: false };
  const pagina = { isClosed: () => janela.fechada };

  // O operador lê e fecha a janela: a rodada segue na hora.
  setTimeout(() => {
    janela.fechada = true;
  }, 300);

  const inicio = Date.now();
  const esperou = await deixarLer(pagina, { situacao: 'erro' }, {}, 30_000);

  assert.equal(esperou, true);
  assert.ok(Date.now() - inicio < 5_000, 'fechar a janela libera na hora');
});

test('janela esquecida não trava a fila dos outros clientes', async () => {
  const inicio = Date.now();
  // Ninguém fecha. O prazo encerra sozinho e a rodada continua.
  await deixarLer(paginaFalsa(false), { situacao: 'indisponivel' }, {}, 700);

  const gasto = Date.now() - inicio;
  assert.ok(gasto >= 600, 'esperou o prazo');
  assert.ok(gasto < 10_000, 'e não esperou para sempre');
});

test('deu certo, não há o que ler: segue direto', async () => {
  const inicio = Date.now();

  // Certidão negativa é o desfecho bom; segurar a janela aqui seria pedir um
  // clique por cliente para nada — o oposto do que o assistido existe para
  // fazer.
  assert.equal(await deixarLer(paginaFalsa(), { situacao: 'negativa' }, {}, 30_000), false);
  assert.equal(await deixarLer(paginaFalsa(), { situacao: 'sem_registro' }, {}, 30_000), false);

  assert.ok(Date.now() - inicio < 1_000);
});

test('dá para desligar a espera e ajustar o prazo', async () => {
  assert.equal(
    await deixarLer(paginaFalsa(), { situacao: 'erro' }, { ASSISTIDO_MANTER_ABERTO: 'nao' }, 30_000),
    false,
  );

  const inicio = Date.now();
  await deixarLer(paginaFalsa(), { situacao: 'erro' }, { ASSISTIDO_LEITURA: '600' }, 30_000);
  assert.ok(Date.now() - inicio < 5_000, 'ASSISTIDO_LEITURA manda no prazo');
});

/**
 * O defeito era a ordem, não a espera.
 *
 * A primeira versão tinha um `return` no meio do caminho: quando o comprovante
 * era legível, a função saía por ali e a janela fechava na cara do operador —
 * exatamente o que a espera existe para impedir. Por isso "fechou de novo".
 */
test('a janela espera mesmo quando o comprovante foi lido', async () => {
  const { concluir } = await import('../src/provedores/assistido.js');

  let consultou = false;
  const pagina = {
    isClosed: () => {
      consultou = true;
      return true; // o operador fechou: libera na hora
    },
  };

  const desfecho = await concluir(
    pagina,
    { situacao: 'indisponivel', detalhe: 'erro interno', arquivo: null },
    { ASSISTIDO_LEITURA: '3000' },
  );

  assert.equal(consultou, true, 'passou pela espera antes de sair');
  assert.equal(desfecho.situacao, 'indisponivel');
});
