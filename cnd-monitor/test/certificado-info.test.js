import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  interpretarSujeito,
  interpretarValidade,
  lerCertificado,
  temOpenssl,
} from '../src/certificado-info.js';

const rodar = promisify(execFile);

// --- Leitura do campo CN ---------------------------------------------------

test('o padrão ICP-Brasil separa razão social e documento', () => {
  assert.deepEqual(
    interpretarSujeito('C = BR, O = ICP-Brasil, CN = TOCA DA ONCA COMERCIO LTDA:56049783000152'),
    { nome: 'TOCA DA ONCA COMERCIO LTDA', documento: '56049783000152' },
  );
});

test('razão social com dois-pontos no meio não confunde o corte', () => {
  // O documento vem depois do ÚLTIMO ":". Cortar no primeiro perderia o nome.
  assert.deepEqual(interpretarSujeito('CN = ABC: SERVICOS LTDA:11222333000181'), {
    nome: 'ABC: SERVICOS LTDA',
    documento: '11222333000181',
  });
});

test('e-CPF também é reconhecido', () => {
  assert.deepEqual(interpretarSujeito('CN = JOAO DA SILVA:12345678909'), {
    nome: 'JOAO DA SILVA',
    documento: '12345678909',
  });
});

test('documento com dígito inválido no CN não é aceito', () => {
  // Melhor não ter documento do que ter um errado: com um CNPJ inválido o
  // cadastro nasceria apontando para a empresa errada.
  assert.equal(interpretarSujeito('CN = EMPRESA:11111111111111').documento, null);
});

test('CN sem documento devolve só o nome', () => {
  assert.deepEqual(interpretarSujeito('CN = AC CERTIFICADORA RAIZ'), {
    nome: 'AC CERTIFICADORA RAIZ',
    documento: null,
  });
});

test('a validade vira data ordenável', () => {
  assert.equal(interpretarValidade('Aug  6 19:14:22 2027 GMT'), '2027-08-06');
  assert.equal(interpretarValidade('lixo'), null);
});

// --- Leitura de um .pfx de verdade ----------------------------------------

async function certificadoDeTeste(cn, senha) {
  const pasta = await mkdtemp(join(tmpdir(), 'pfx-'));
  const chave = join(pasta, 'k.pem');
  const publico = join(pasta, 'c.pem');
  const pfx = join(pasta, 'certificado.pfx');

  await rodar('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', chave, '-out', publico,
    '-days', '400', '-nodes', '-subj', `/C=BR/O=ICP-Brasil/CN=${cn}`,
  ]);
  await rodar('openssl', [
    'pkcs12', '-export', '-out', pfx, '-inkey', chave, '-in', publico,
    '-passout', `pass:${senha}`,
  ]);
  return pfx;
}

test('lê o titular de dentro de um .pfx cujo nome não diz nada', async (t) => {
  if (!(await temOpenssl())) return t.skip('openssl indisponível');

  const pfx = await certificadoDeTeste('TOCA DA ONCA COMERCIO LTDA:56049783000152', 'senha123');
  const info = await lerCertificado(pfx, 'senha123');

  assert.equal(info.documento, '56049783000152');
  assert.equal(info.nome, 'TOCA DA ONCA COMERCIO LTDA');
  assert.equal(info.tipo, 'cnpj');
  assert.match(info.validoAte, /^\d{4}-\d{2}-\d{2}$/);
});

test('senha errada devolve motivo, não exceção', async (t) => {
  if (!(await temOpenssl())) return t.skip('openssl indisponível');

  const pfx = await certificadoDeTeste('EMPRESA LTDA:11222333000181', 'certa');
  const info = await lerCertificado(pfx, 'errada');

  // Um arquivo com senha errada não pode interromper a leitura dos outros 22.
  assert.equal(info.documento, undefined);
  assert.match(info.erro, /senha incorreta/);
});

test('a senha não aparece na linha de comando do processo', async () => {
  const fonte = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/certificado-info.js', import.meta.url), 'utf8'),
  );

  // `-passin pass:SENHA` exporia a senha do certificado do cliente para
  // qualquer `ps` da máquina. Ela vai pelo descritor 3.
  assert.doesNotMatch(fonte, /pass:\$\{|['"`]pass:/);
  assert.match(fonte, /fd:3/);
});
