import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import { perguntarSenha, perguntarTexto } from '../src/senha.js';

const ENTER = '\r';
const BACKSPACE = '\u007f';
const CTRL_C = '\u0003';

function terminalFalso() {
  const entrada = new PassThrough();
  entrada.isTTY = true;

  const saida = new PassThrough();
  saida.escrito = '';
  saida.on('data', (p) => (saida.escrito += p));
  return { entrada, saida };
}

test('a senha e lida sem aparecer na tela', async () => {
  const { entrada, saida } = terminalFalso();

  const promessa = perguntarSenha('Senha: ', entrada, saida);
  entrada.write('segredo');
  entrada.write(ENTER);

  assert.equal(await promessa, 'segredo');
  // O rotulo sai; a senha nao. Eco de senha fica no scrollback do terminal e
  // aparece em compartilhamento de tela.
  assert.match(saida.escrito, /Senha: /);
  assert.doesNotMatch(saida.escrito, /segredo/);
});

test('backspace apaga o ultimo caractere', async () => {
  const { entrada, saida } = terminalFalso();

  const promessa = perguntarSenha('Senha: ', entrada, saida);
  entrada.write('senhaX');
  entrada.write(BACKSPACE);
  entrada.write(ENTER);

  assert.equal(await promessa, 'senha');
});

test('Ctrl+C cancela em vez de devolver senha pela metade', async () => {
  const { entrada, saida } = terminalFalso();

  const promessa = perguntarSenha('Senha: ', entrada, saida);
  entrada.write('meia');
  entrada.write(CTRL_C);

  await assert.rejects(promessa, /Cancelado/);
});

test('a escolha numerica aparece na tela -- nao e segredo', async () => {
  const { entrada, saida } = terminalFalso();

  const promessa = perguntarTexto('Numero: ', entrada, saida);
  entrada.write('3\n');

  assert.equal(await promessa, '3');
  assert.match(saida.escrito, /Numero: /);
});

test('senha colada de uma vez e reconhecida ate o Enter', async () => {
  const { entrada, saida } = terminalFalso();

  // Colar entrega tudo num bloco so. Tratando o bloco como uma tecla, o Enter
  // no fim dele nao era reconhecido e o prompt esperava para sempre -- com a
  // senha inteira ja digitada na tela.
  const promessa = perguntarSenha('Senha: ', entrada, saida);
  entrada.write(`senha-colada${ENTER}`);

  assert.equal(await promessa, 'senha-colada');
});

test('o que vem depois do Enter nao entra na senha', async () => {
  const { entrada, saida } = terminalFalso();

  const promessa = perguntarSenha('Senha: ', entrada, saida);
  entrada.write(`abc${ENTER}lixo`);

  assert.equal(await promessa, 'abc');
});

test('as duas perguntas encadeiam sem brigar pelo stdin', async () => {
  const { entrada, saida } = terminalFalso();

  // E a sequencia real: escolher o certificado e depois informar a senha. Uma
  // deixando o stream em estado errado travaria a outra.
  const numero = perguntarTexto('Numero: ', entrada, saida);
  entrada.write('2\n');
  assert.equal(await numero, '2');

  const senha = perguntarSenha('Senha: ', entrada, saida);
  entrada.write(`abc${ENTER}`);
  assert.equal(await senha, 'abc');
});

test('sem terminal interativo, recusa em vez de travar esperando', async () => {
  const entrada = new PassThrough(); // isTTY ausente
  await assert.rejects(perguntarSenha('Senha: ', entrada, new PassThrough()), /terminal/i);
});
