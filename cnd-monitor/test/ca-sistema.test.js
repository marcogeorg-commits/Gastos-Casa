import test from 'node:test';
import assert from 'node:assert/strict';
import { getCACertificates } from 'node:tls';

import { confiarNasCasDoSistema, falhaDeCadeia } from '../src/ca-sistema.js';

/**
 * O e-CAC falhou por meia hora parecendo outra coisa: HTTP 503 e página vazia
 * são a cara de portal fora do ar. A mensagem verdadeira estava no corpo.
 */
test('reconhece a falha de cadeia disfarçada de portal fora do ar', () => {
  assert.equal(
    falhaDeCadeia(
      'Playwright client-certificate error: unable to verify the first certificate; ' +
        'if the root CA is installed locally, try running Node.js with --use-system-ca',
    ),
    true,
  );
  assert.equal(falhaDeCadeia('self signed certificate in certificate chain'), true);

  // E não pode confundir com portal realmente fora do ar, nem com tela cheia:
  // a correção de uma não serve para a outra.
  assert.equal(falhaDeCadeia('Serviço temporariamente indisponível'), false);
  assert.equal(falhaDeCadeia('Entrar com gov.br'), false);
  assert.equal(falhaDeCadeia(''), false);
  assert.equal(falhaDeCadeia(null), false);
});

// O Node reescreve o PEM ao guardá-lo: mesma autoridade, quebras de linha
// diferentes. Comparar texto cru acusaria perda que não houve.
const semEspacos = (pem) => pem.replace(/\s/g, '');

test('as autoridades do sistema entram sem tirar as que já valiam', async () => {
  const antes = getCACertificates('default').map(semEspacos);
  const sistema = getCACertificates('system').map(semEspacos);

  const r = await confiarNasCasDoSistema();
  assert.equal(r.aplicado, true, r.motivo);

  const depois = new Set(getCACertificates('default').map(semEspacos));
  // União, não substituição: perder as embarcadas quebraria toda conexão HTTPS
  // comum do programa para consertar a do portal.
  for (const ca of antes) assert.ok(depois.has(ca), 'nenhuma autoridade anterior foi removida');
  for (const ca of sistema) assert.ok(depois.has(ca), 'as do sistema passaram a valer');
});

test('chamar de novo não refaz o trabalho', async () => {
  const primeiro = await confiarNasCasDoSistema();
  assert.deepEqual(await confiarNasCasDoSistema(), primeiro);
});

test('o que está na pasta ca/ passa a valer junto', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { lerCasLocais } = await import('../src/ca-sistema.js');

  const pasta = await mkdtemp(join(tmpdir(), 'cnd-caloc-'));
  const bloco = (n) => `-----BEGIN CERTIFICATE-----\n${n}\n-----END CERTIFICATE-----`;
  // Um arquivo com a cadeia inteira: os dois blocos têm de entrar.
  await writeFile(join(pasta, 'cadeia.pem'), `${bloco('AAA')}\n${bloco('BBB')}\n`);
  await writeFile(join(pasta, 'leiame.txt'), 'isto não é certificado');

  assert.equal((await lerCasLocais(pasta)).length, 2);
  // Pasta que não existe não é erro: quem nunca rodou `npm run cadeia` não tem.
  assert.deepEqual(await lerCasLocais(join(pasta, 'nao-existe')), []);
});
