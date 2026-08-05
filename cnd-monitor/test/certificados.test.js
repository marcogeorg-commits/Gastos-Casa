import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  dentroDoProjeto,
  expandirCaminho,
  resolverCertificado,
} from '../src/certificados.js';

const RAIZ = resolve(import.meta.dirname, '..');

async function pastaComCertificado(nome = 'alfa.pfx') {
  const pasta = await mkdtemp(join(tmpdir(), 'cert-'));
  await writeFile(join(pasta, nome), 'conteúdo irrelevante para o teste', 'utf8');
  return pasta;
}

const cliente = (certificado) => ({ nome: 'Alfa Ltda', certificado });

test('expande o til para a pasta do usuário', () => {
  assert.equal(expandirCaminho('~/Certificados/alfa.pfx', '/Users/marco'),
    resolve('/Users/marco', 'Certificados/alfa.pfx'));
  assert.equal(expandirCaminho('~', '/Users/marco'), '/Users/marco');
  assert.equal(expandirCaminho('/absoluto/alfa.pfx', '/Users/marco'), '/absoluto/alfa.pfx');
});

test('reconhece o que está dentro do projeto', () => {
  assert.equal(dentroDoProjeto(join(RAIZ, 'certificados', 'alfa.pfx')), true);
  assert.equal(dentroDoProjeto(RAIZ), true);
  assert.equal(dentroDoProjeto('/tmp/alfa.pfx'), false);
  // Vizinho de nome parecido não pode ser confundido com o próprio projeto.
  assert.equal(dentroDoProjeto(`${RAIZ}-outro${sep}alfa.pfx`), false);
});

test('recusa certificado guardado dentro do repositório', async () => {
  const { erro } = await resolverCertificado(
    cliente({ arquivo: join(RAIZ, 'certificados', 'alfa.pfx'), senhaVariavel: 'SENHA' }),
    {},
    { SENHA: 'x' },
  );

  assert.match(erro, /dentro do projeto/);
  assert.match(erro, /histórico do Git/, 'a mensagem precisa dizer por que isso é grave');
});

test('recusa senha escrita no cadastro', async () => {
  const pasta = await pastaComCertificado();
  const { erro } = await resolverCertificado(
    cliente({ arquivo: 'alfa.pfx', senha: 'segredo123' }),
    { certificados: { pastaPadrao: pasta } },
    {},
  );

  assert.match(erro, /não pode ficar no cadastro/);
});

test('exige que a variável de ambiente exista', async () => {
  const pasta = await pastaComCertificado();
  const config = { certificados: { pastaPadrao: pasta } };

  const semVariavel = await resolverCertificado(cliente({ arquivo: 'alfa.pfx' }), config, {});
  assert.match(semVariavel.erro, /senhaVariavel/);

  const semValor = await resolverCertificado(
    cliente({ arquivo: 'alfa.pfx', senhaVariavel: 'CERT_ALFA' }),
    config,
    {},
  );
  assert.match(semValor.erro, /CERT_ALFA não está definida/);
});

test('avisa quando o arquivo não existe, dizendo onde procurou', async () => {
  const pasta = await pastaComCertificado();
  const { erro } = await resolverCertificado(
    cliente({ arquivo: 'inexistente.pfx', senhaVariavel: 'CERT' }),
    { certificados: { pastaPadrao: pasta } },
    { CERT: 'x' },
  );

  assert.match(erro, /não encontrado/);
  assert.match(erro, new RegExp(pasta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('resolve caminho relativo à pasta padrão e lê a senha do ambiente', async () => {
  const pasta = await pastaComCertificado();
  const resultado = await resolverCertificado(
    cliente({ arquivo: 'alfa.pfx', senhaVariavel: 'CERT_ALFA' }),
    { certificados: { pastaPadrao: pasta } },
    { CERT_ALFA: 'senha-do-cofre' },
  );

  assert.equal(resultado.erro, undefined);
  assert.equal(resultado.caminho, join(pasta, 'alfa.pfx'));
  assert.equal(resultado.senha, 'senha-do-cofre');
});

test('cliente sem certificado é recusado com explicação, não com exceção', async () => {
  const { erro } = await resolverCertificado({ nome: 'Beta Ltda' }, {}, {});
  assert.match(erro, /sem certificado digital/);
});
