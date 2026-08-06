import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analisar } from '../src/ambiente.js';
import { CSS_MARCA, marca, timbre } from '../src/marca.js';
import {
  TOKEN,
  criarServidor,
  listarCertificados,
  origemConfiavel,
  resolverCaminho,
  sanearConfig,
} from '../src/servidor.js';

// --- .env ------------------------------------------------------------------

test('o .env aceita comentário, aspas e "export"', () => {
  const valores = analisar(`
    # senha do primeiro cliente
    CERT_ALFA=abc123
    export CERT_BETA="com espaço"
    CERT_GAMA='aspas simples'
    linha sem igual
  `);

  assert.deepEqual(valores, {
    CERT_ALFA: 'abc123',
    CERT_BETA: 'com espaço',
    CERT_GAMA: 'aspas simples',
  });
});

test('senha com "=" no meio não é cortada', () => {
  assert.equal(analisar('CERT_X=a=b=c').CERT_X, 'a=b=c');
});

// --- Peneira do cadastro ---------------------------------------------------

test('a senha do certificado nunca chega ao clientes.json', () => {
  const salvo = sanearConfig({
    provedorPadrao: 'ecac',
    clientes: [
      {
        nome: 'Alfa',
        documento: '11222333000181',
        certificado: { arquivo: 'alfa.pfx', senhaVariavel: 'CERT_ALFA', senha: 'segredo' },
      },
    ],
  });

  assert.equal(salvo.clientes[0].certificado.senha, undefined);
  assert.equal(salvo.clientes[0].certificado.senhaVariavel, 'CERT_ALFA');
});

test('campo inventado pelo navegador não entra no arquivo', () => {
  const salvo = sanearConfig({
    clientes: [{ nome: 'Alfa', documento: '1', __proto__polui: 'x', script: '<img onerror>' }],
  });

  assert.deepEqual(Object.keys(salvo.clientes[0]), ['nome', 'documento']);
});

test('o nome da variável de senha é normalizado', () => {
  const salvo = sanearConfig({
    clientes: [{ certificado: { arquivo: 'a.pfx', senhaVariavel: 'cert alfa-1!' } }],
  });

  assert.equal(salvo.clientes[0].certificado.senhaVariavel, 'CERTALFA1');
});

// --- Defesas do servidor ---------------------------------------------------

test('só a própria página é origem aceita', () => {
  assert.equal(origemConfiavel('http://localhost:8787', 8787), true);
  assert.equal(origemConfiavel('http://127.0.0.1:8787', 8787), true);
  assert.equal(origemConfiavel(undefined, 8787), true);
  assert.equal(origemConfiavel('https://site-qualquer.com', 8787), false);
  // Porta diferente é outro processo: não é o painel desta sessão.
  assert.equal(origemConfiavel('http://localhost:9999', 8787), false);
});

test('nenhum caminho pedido sai da pasta do projeto', () => {
  const hostis = [
    '/../../etc/passwd',
    '/painel/../../../.ssh/id_rsa',
    '/%2e%2e%2f%2e%2e%2fetc/passwd',
    '/....//....//etc/passwd',
  ];

  for (const url of hostis) {
    const destino = resolverCaminho(url, '/projeto');
    // Ou recusa, ou aterrissa dentro de /projeto — nunca acima dele.
    assert.ok(
      destino === null || destino.startsWith('/projeto/'),
      `${url} escapou para ${destino}`,
    );
  }

  assert.equal(resolverCaminho('/painel/marca.css', '/projeto'), '/projeto/painel/marca.css');
});

test('as senhas e o histórico do Git não são servidos como arquivo estático', () => {
  // Estão dentro da pasta, então a checagem de contenção não os pega: sem a
  // lista de proibidos, `GET /.env` entregaria a senha de todo certificado.
  for (const url of ['/.env', '/.env.exemplo', '/.git/config', '/calibracao/ecac-alfa.png']) {
    assert.equal(resolverCaminho(url, '/projeto'), null, `${url} foi servido`);
  }
});

test('a página do painel continua sendo servida', () => {
  assert.equal(resolverCaminho('/', '/projeto'), '/projeto/painel/index.html');
  assert.equal(resolverCaminho('/relatorios/2026-08.html', '/projeto'), '/projeto/relatorios/2026-08.html');
});

async function projetoTemporario() {
  const raiz = await mkdtemp(join(tmpdir(), 'painel-'));
  await mkdir(join(raiz, 'painel'), { recursive: true });
  await writeFile(
    join(raiz, 'clientes.json'),
    JSON.stringify({ provedorPadrao: 'mock', clientes: [{ nome: 'Alfa', documento: '11222333000181' }] }),
  );
  await writeFile(join(raiz, 'painel/index.html'), '<p>token: __TOKEN_DO_PAINEL__</p>');
  return raiz;
}

async function comServidor(raiz, tarefa) {
  const servidor = criarServidor(raiz, 0);
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  const porta = servidor.address().port;
  try {
    return await tarefa(`http://127.0.0.1:${porta}`);
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }
}

test('sem o token, a API não responde nada', async () => {
  const raiz = await projetoTemporario();
  await comServidor(raiz, async (base) => {
    const r = await fetch(`${base}/api/estado`);
    assert.equal(r.status, 403);

    const gravacao = await fetch(`${base}/api/clientes`, {
      method: 'POST',
      body: JSON.stringify({ clientes: [] }),
    });
    assert.equal(gravacao.status, 403);
  });
});

test('página de outra origem não consegue gravar, mesmo com token', async () => {
  const raiz = await projetoTemporario();
  await comServidor(raiz, async (base) => {
    const r = await fetch(`${base}/api/clientes`, {
      method: 'POST',
      headers: { 'x-token': TOKEN, origin: 'https://site-qualquer.com' },
      body: JSON.stringify({ clientes: [] }),
    });
    assert.equal(r.status, 403);

    // O cadastro seguiu intacto.
    const disco = JSON.parse(await readFile(join(raiz, 'clientes.json'), 'utf8'));
    assert.equal(disco.clientes.length, 1);
  });
});

test('com o token, o painel lê e grava o cadastro', async () => {
  const raiz = await projetoTemporario();
  await comServidor(raiz, async (base) => {
    const estado = await (await fetch(`${base}/api/estado`, { headers: { 'x-token': TOKEN } })).json();
    assert.equal(estado.config.clientes[0].nome, 'Alfa');

    const r = await fetch(`${base}/api/clientes`, {
      method: 'POST',
      headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({
        provedorPadrao: 'web',
        clientes: [{ nome: 'Beta', documento: '22333444000181' }],
      }),
    });
    assert.equal(r.status, 200);

    const disco = JSON.parse(await readFile(join(raiz, 'clientes.json'), 'utf8'));
    assert.equal(disco.clientes[0].nome, 'Beta');
    assert.equal(disco.provedorPadrao, 'web');
  });
});

test('a gravação guarda a versão anterior antes de sobrescrever', async () => {
  const raiz = await projetoTemporario();
  await comServidor(raiz, async (base) => {
    await fetch(`${base}/api/clientes`, {
      method: 'POST',
      headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ clientes: [] }),
    });

    const anterior = JSON.parse(
      await readFile(join(raiz, 'historico/clientes.anterior.json'), 'utf8'),
    );
    assert.equal(anterior.clientes[0].nome, 'Alfa');
  });
});

test('o token entra na página servida, não numa rota pública', async () => {
  const raiz = await projetoTemporario();
  await comServidor(raiz, async (base) => {
    const pagina = await (await fetch(`${base}/`)).text();
    assert.match(pagina, new RegExp(TOKEN));
    assert.doesNotMatch(pagina, /__TOKEN_DO_PAINEL__/);
  });
});

// --- Certificados ----------------------------------------------------------

test('a lista de certificados traz só os .pfx, e só o nome', async () => {
  const pasta = await mkdtemp(join(tmpdir(), 'certs-'));
  await writeFile(join(pasta, 'alfa.pfx'), 'x');
  await writeFile(join(pasta, 'beta.P12'), 'x');
  await writeFile(join(pasta, 'anotacoes.txt'), 'x');

  const { arquivos, erro } = await listarCertificados(pasta);
  assert.deepEqual(arquivos, ['alfa.pfx', 'beta.P12']);
  assert.equal(erro, null);
});

test('pasta de certificados inexistente vira aviso, não exceção', async () => {
  const { arquivos, erro } = await listarCertificados('/pasta/que/nao/existe');
  assert.deepEqual(arquivos, []);
  assert.match(erro, /não encontrada/i);
});

// --- Identidade ------------------------------------------------------------

test('o relatório e o painel usam a mesma folha de estilo', async () => {
  const doDisco = await readFile(new URL('../painel/marca.css', import.meta.url), 'utf8');
  assert.equal(CSS_MARCA, doDisco);
  assert.match(CSS_MARCA, /--osso:\s*#f2eee5/);
});

test('sem arquivo de logotipo, a marca é montada com tipografia', () => {
  assert.match(marca(null), /ABC/);
  assert.match(marca(null), /EMBRALOT/);
  assert.doesNotMatch(marca(null), /<img/);
});

test('havendo logotipo, ele entra embutido — o relatório viaja sozinho', () => {
  const html = timbre({ logo: 'data:image/svg+xml;base64,QQ==' });
  assert.match(html, /<img class="marca__logo" src="data:image\/svg\+xml;base64,QQ=="/);
  assert.match(html, /alt="ABC.inc &amp; EMBRALOT"/);
});
