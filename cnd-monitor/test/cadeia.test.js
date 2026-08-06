import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';

import {
  autoassinado,
  cadeiaDoSocket,
  completar,
  conectar,
  enderecoDoEmissor,
  guardarCadeia,
  portaisPedidos,
} from '../src/cadeia.js';
import { separarCertificados } from '../src/ca-sistema.js';

/**
 * Monta raiz -> intermediária -> folha numa pasta temporária.
 *
 * Fica aqui, e não numa variável de ambiente apontando para certificados
 * prontos, porque teste que depende de preparo externo é teste que vira
 * "pulado" em silêncio e envelhece sem ninguém ver -- foi o que acabou de
 * acontecer com os testes do painel.
 */
async function montarCadeia() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ssl = promisify(execFile);

  const dir = await mkdtemp(join(tmpdir(), 'cnd-cadeia-'));
  const p = (n) => join(dir, n);
  const rodar = (args) => ssl('openssl', args, { cwd: dir });

  await rodar(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', p('raiz.key'), '-out', p('raiz.pem'),
    '-days', '2', '-nodes', '-subj', '/CN=Raiz de Teste']);

  await rodar(['req', '-newkey', 'rsa:2048', '-keyout', p('inter.key'), '-out', p('inter.csr'),
    '-nodes', '-subj', '/CN=Intermediaria de Teste']);
  await writeFile(p('inter.cnf'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n');
  await rodar(['x509', '-req', '-in', p('inter.csr'), '-CA', p('raiz.pem'), '-CAkey', p('raiz.key'),
    '-CAcreateserial', '-out', p('inter.pem'), '-days', '2', '-extfile', p('inter.cnf')]);

  await rodar(['req', '-newkey', 'rsa:2048', '-keyout', p('folha.key'), '-out', p('folha.csr'),
    '-nodes', '-subj', '/CN=localhost']);
  await writeFile(p('folha.cnf'), 'subjectAltName=DNS:localhost\n');
  await rodar(['x509', '-req', '-in', p('folha.csr'), '-CA', p('inter.pem'), '-CAkey', p('inter.key'),
    '-CAcreateserial', '-out', p('folha.pem'), '-days', '2', '-extfile', p('folha.cnf')]);

  return dir;
}

let CERTS = null;
before(async () => {
  CERTS = await montarCadeia().catch(() => null);
});

test('separa a cadeia inteira quando vem num arquivo só', () => {
  const bloco = (n) => `-----BEGIN CERTIFICATE-----\n${n}\n-----END CERTIFICATE-----`;
  // Entregar o arquivo inteiro ao Node como um texto só faria valer apenas o
  // primeiro certificado -- e o que costuma faltar é o segundo.
  assert.equal(separarCertificados(`${bloco('AAA')}\n${bloco('BBB')}\n`).length, 2);
  assert.deepEqual(separarCertificados('lixo sem certificado'), []);
  assert.deepEqual(separarCertificados(null), []);
});

test('lê o endereço do emissor anunciado no certificado', () => {
  assert.equal(
    enderecoDoEmissor({ infoAccess: 'OCSP - URI:http://ocsp.exemplo\nCA Issuers - URI:http://ca.exemplo/i.crt\n' }),
    'http://ca.exemplo/i.crt',
  );
  // Endereço ldap existe em cadeia da ICP-Brasil e não dá para buscar aqui.
  assert.equal(enderecoDoEmissor({ infoAccess: 'CA Issuers - URI:ldap://x/cn=a' }), null);
  assert.equal(enderecoDoEmissor({}), null);
});

test('sem argumento cuida dos portais do login do e-CAC', () => {
  assert.ok(portaisPedidos([]).includes('cav.receita.fazenda.gov.br'));
  // Aceita URL colada ou só o nome.
  assert.deepEqual(portaisPedidos(['https://exemplo.gov.br/x']), ['exemplo.gov.br']);
});

test('pega do servidor a cadeia que ele apresenta e guarda só as autoridades', async (t) => {
  if (!CERTS) return t.skip('openssl indisponível para montar a cadeia');

  const [folha, chave, inter, raiz] = await Promise.all([
    readFile(join(CERTS, 'folha.pem')),
    readFile(join(CERTS, 'folha.key')),
    readFile(join(CERTS, 'inter.pem')),
    readFile(join(CERTS, 'raiz.pem')),
  ]);

  // O servidor manda folha + intermediária, como faz um portal bem
  // configurado. A raiz nunca vem na conexão.
  const servidor = createServer({ key: chave, cert: Buffer.concat([folha, inter]) }, (_, res) => res.end('ok'));
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  const porta = servidor.address().port;

  try {
    const socket = await conectar('localhost', porta);
    const cadeia = cadeiaDoSocket(socket);
    socket.destroy();

    assert.equal(cadeia.length, 2, 'folha e intermediária');
    assert.match(cadeia[0].subject, /localhost/);
    assert.match(cadeia[1].subject, /Intermediaria/);
    // A raiz assina a si mesma; a intermediária, não.
    assert.equal(autoassinado(cadeia[1]), false);
    assert.equal(autoassinado(new X509Certificate(raiz)), true);
  } finally {
    servidor.close();
  }
});

test('sobe até a raiz buscando o emissor anunciado', async (t) => {
  if (!CERTS) return t.skip('openssl indisponível para montar a cadeia');

  const raiz = await readFile(join(CERTS, 'raiz.pem'));

  // A intermediária entra como o servidor a entregaria, mas com o campo que
  // diz onde buscar quem a assinou. É esse passo que o navegador dá sozinho e
  // o Node não dá.
  const intermediaria = {
    subject: 'CN=Intermediaria de Teste',
    issuer: 'CN=Raiz de Teste',
    fingerprint256: 'aa:bb',
    infoAccess: 'CA Issuers - URI:http://ca.exemplo/raiz.crt',
  };
  const buscar = async () => ({ ok: true, status: 200, arrayBuffer: async () => raiz });

  const completa = await completar([intermediaria], { buscar });

  assert.equal(completa.length, 2, 'a raiz buscada entrou');
  assert.match(completa[1].subject, /Raiz de Teste/);
  // Chegou na raiz: ela assina a si mesma, então a subida para aqui.
  assert.equal(autoassinado(completa[1]), true);
});

test('a busca que falha não derruba o que já foi obtido', async () => {
  const topo = { subject: 'CN=A', issuer: 'CN=B', infoAccess: 'CA Issuers - URI:http://x/y.crt' };
  const buscar = async () => ({ ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) });

  const avisos = [];
  const completa = await completar([topo], { buscar, registrar: (m) => avisos.push(m) });

  // Cadeia parcial ainda pode ser o que faltava; parar com nada seria pior.
  assert.equal(completa.length, 1);
  assert.ok(avisos.some((a) => /404/.test(a)));
});

test('guarda em ca/ tudo menos o certificado do próprio site', async (t) => {
  if (!CERTS) return t.skip('openssl indisponível para montar a cadeia');

  const [folha, chave, inter] = await Promise.all([
    readFile(join(CERTS, 'folha.pem')),
    readFile(join(CERTS, 'folha.key')),
    readFile(join(CERTS, 'inter.pem')),
  ]);

  const servidor = createServer({ key: chave, cert: Buffer.concat([folha, inter]) }, (_, res) => res.end('ok'));
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));

  try {
    const pasta = await mkdtemp(join(tmpdir(), 'cnd-ca-'));
    const { caminho, autoridades } = await guardarCadeia('localhost', {
      pasta,
      porta: servidor.address().port,
    });

    const guardado = await readFile(caminho, 'utf8');
    const blocos = separarCertificados(guardado);
    // Confiar no certificado do site autenticaria aquele servidor sem
    // verificar cadeia nenhuma -- é o oposto do que se quer.
    assert.equal(blocos.length, 1, 'só a intermediária');
    assert.match(autoridades[0], /Intermediaria/);
    assert.doesNotMatch(guardado, /localhost/);
  } finally {
    servidor.close();
  }
});
