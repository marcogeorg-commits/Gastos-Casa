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

test('pasta irmã "../Certificados" é aceita; dentro do projeto é sinalizada', async () => {
  const escritorio = await mkdtemp(join(tmpdir(), 'escritorio-'));
  const projeto = join(escritorio, 'cnd-monitor');
  const guardados = join(escritorio, 'Certificados');
  await mkdir(projeto, { recursive: true });
  await mkdir(guardados, { recursive: true });
  await writeFile(join(guardados, 'alfa.pfx'), 'x');

  // A pasta irmã: caminho relativo resolvido a partir do projeto, não do cwd.
  const irma = await listarCertificados('../Certificados', projeto);
  assert.equal(irma.dentroDoProjeto, false);
  assert.deepEqual(irma.arquivos, ['alfa.pfx']);

  // A mesma escolha feita errado, um nível abaixo.
  await mkdir(join(projeto, 'Certificados'), { recursive: true });
  const dentro = await listarCertificados('./Certificados', projeto);
  assert.equal(dentro.dentroDoProjeto, true);
});

test('o certificado dentro do projeto continua sendo recusado na hora da rodada', async () => {
  const { resolverCertificado } = await import('../src/certificados.js');

  const recusa = await resolverCertificado(
    { nome: 'Alfa', certificado: { arquivo: 'alfa.pfx', senhaVariavel: 'CERT_ALFA' } },
    { certificados: { pastaPadrao: './calibracao' } },
    { CERT_ALFA: 'x' },
  );

  assert.match(recusa.erro, /dentro do projeto/);
  // A mensagem precisa dizer para onde ir, não só que está errado.
  assert.match(recusa.erro, /\.\.\/Certificados/);
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

// --- Ponto de entrada ------------------------------------------------------

test('o CLI reconhece que foi chamado direto mesmo com espaço no caminho', async () => {
  const { chamadoDireto } = await import('../src/executavel.js');
  const { pathToFileURL } = await import('node:url');

  // O caminho real do escritório: espaço e apóstrofo, os dois percent-encoded
  // em import.meta.url e crus em process.argv[1].
  const caminho = "/Users/marco/LG IA's/Projetos Claude/CND/cnd-monitor/src/index.js";
  const url = pathToFileURL(caminho).href;

  assert.match(url, /%20/, 'o espaço precisa estar codificado para o teste valer');
  assert.equal(chamadoDireto(url, ['node', caminho]), true);

  // A comparação ingênua que havia antes — deixada aqui como lembrete de que
  // ela passa no caminho simples e falha em silêncio no caminho com espaço.
  assert.notEqual(url, `file://${caminho}`);
});

test('importado por um teste, o CLI não se executa sozinho', async () => {
  const { chamadoDireto } = await import('../src/executavel.js');
  const { pathToFileURL } = await import('node:url');

  const modulo = pathToFileURL('/projeto/src/servidor.js').href;
  assert.equal(chamadoDireto(modulo, ['node', '/projeto/test/roda.test.js']), false);
  assert.equal(chamadoDireto(modulo, ['node']), false);
});

// --- Consulta avulsa e recuperação do cadastro -----------------------------

test('a consulta avulsa valida o documento antes de tocar em qualquer portal', async () => {
  const { configAvulsa } = await import('../src/config.js');

  assert.throws(() => configAvulsa({ documento: 'abc' }), /não parece um CPF nem um CNPJ/);
  assert.throws(() => configAvulsa({ documento: '11.222.333/0001-99' }), /dígito verificador/);
});

test('a consulta avulsa só pede as certidões que valem para o tipo de documento', async () => {
  const { configAvulsa } = await import('../src/config.js');

  // SEFAZ/SC e municipal não se aplicam a CPF.
  const pf = configAvulsa({ documento: '123.456.780-62', certidoes: ['rfb_pgfn', 'sefaz_sc'] });
  assert.deepEqual(pf.certidoesAtivas, ['rfb_pgfn']);

  // Municipal sem município vira aviso, não consulta silenciosamente errada.
  const pj = configAvulsa({ documento: '11.222.333/0001-81', certidoes: ['rfb_pgfn', 'municipal'] });
  assert.deepEqual(pj.certidoesAtivas, ['rfb_pgfn']);
  assert.match(pj.avisos.join(' '), /exige o município/);
});

test('a consulta avulsa não inventa cliente nem mexe no cadastro', async () => {
  const { configAvulsa } = await import('../src/config.js');

  const config = configAvulsa({ documento: '11.222.333/0001-81', provedor: 'mock' });
  assert.equal(config.clientes.length, 1);
  assert.equal(config.clientes[0].documento, '11222333000181');
  assert.equal(config.clientes[0].certificado, null);
  assert.equal(config.provedorPadrao, 'mock');
});

test('o cadastro é recriado quando falta, e preservado quando existe', async () => {
  const { garantirCadastro } = await import('../src/servidor.js');
  const raiz = await mkdtemp(join(tmpdir(), 'cadastro-'));

  // Foi exatamente isto que um `git pull` provocou: o arquivo sumiu e o painel
  // abriu vazio, sem dizer por quê.
  const primeira = await garantirCadastro(raiz);
  assert.equal(primeira.criado, true);

  const criado = JSON.parse(await readFile(join(raiz, 'clientes.json'), 'utf8'));
  assert.deepEqual(criado.clientes, []);
  assert.equal(criado.certificados.pastaPadrao, '../Certificados');

  // Segunda subida não pode passar por cima da carteira de verdade.
  await writeFile(
    join(raiz, 'clientes.json'),
    JSON.stringify({ clientes: [{ nome: 'Alfa', documento: '11222333000181' }] }),
  );
  const segunda = await garantirCadastro(raiz);
  assert.equal(segunda.criado, false);

  const depois = JSON.parse(await readFile(join(raiz, 'clientes.json'), 'utf8'));
  assert.equal(depois.clientes[0].nome, 'Alfa');
});

test('a pasta de certificados sobrevive a uma gravação que não a mencione', () => {
  // O painel manda o cadastro inteiro; um estado montado sem o campo apagava a
  // configuração da pasta, e os certificados sumiam da lista.
  const salvo = sanearConfig({ clientes: [] });
  assert.equal(salvo.certificados.pastaPadrao, '../Certificados');
});

// --- Roteamento por certidão ----------------------------------------------

test('cada certidão vai ao provedor que a atende', async () => {
  const { rotear } = await import('../src/provedores/index.js');

  const mapa = rotear([
    'rfb_pgfn', 'cadin_federal', 'situacao_fiscal', 'fgts_crf', 'cndt', 'sefaz_sc',
  ]);

  // Só o e-CAC alcança CADIN e Situação Fiscal.
  assert.equal(mapa.cadin_federal, 'ecac');
  assert.equal(mapa.situacao_fiscal, 'ecac');

  // O resto o e-CAC não atende: antes voltava "o provedor ecac não atende
  // rfb_pgfn" e virava conferência manual sem motivo.
  assert.equal(mapa.rfb_pgfn, 'web');
  assert.equal(mapa.fgts_crf, 'web');
  assert.equal(mapa.cndt, 'web');
});

test('"auto" na consulta avulsa distribui em vez de impor um provedor', async () => {
  const { configAvulsa } = await import('../src/config.js');

  const config = configAvulsa({
    documento: '11.222.333/0001-81',
    certidoes: ['rfb_pgfn', 'cadin_federal'],
    provedor: 'auto',
  });

  assert.equal(config.provedores.cadin_federal, 'ecac');
  assert.equal(config.provedores.rfb_pgfn, 'web');
});

test('escolher um provedor específico continua valendo para tudo', async () => {
  const { configAvulsa } = await import('../src/config.js');

  const config = configAvulsa({ documento: '11.222.333/0001-81', provedor: 'mock' });
  assert.equal(config.provedorPadrao, 'mock');
  assert.deepEqual(config.provedores, {});
});

// --- Casamento do certificado ---------------------------------------------

test('o certificado é reconhecido pelo CNPJ no nome do arquivo', async () => {
  const { casarPorDocumento } = await import('../src/certificados.js');

  const pasta = [
    'TOCA DA ONCA LTDA 56049783000152.pfx',
    'OUTRA EMPRESA 11222333000181.pfx',
    'anotacoes.txt',
  ];

  assert.equal(casarPorDocumento(pasta, '56.049.783/0001-52'), 'TOCA DA ONCA LTDA 56049783000152.pfx');
  assert.equal(casarPorDocumento(pasta, '56049783000152'), 'TOCA DA ONCA LTDA 56049783000152.pfx');
});

test('o nome do arquivo pode vir com o CNPJ pontuado', async () => {
  const { casarPorDocumento } = await import('../src/certificados.js');
  const pasta = ['EMPRESA 56.049.783-0001-52 (A1).pfx'];
  assert.equal(casarPorDocumento(pasta, '56049783000152'), pasta[0]);
});

test('na dúvida o programa não escolhe certificado', async () => {
  const { casarPorDocumento } = await import('../src/certificados.js');

  // Dois arquivos do mesmo CNPJ (renovação): quem decide é o humano.
  const duplicado = ['EMP 56049783000152 2025.pfx', 'EMP 56049783000152 2026.pfx'];
  assert.equal(casarPorDocumento(duplicado, '56049783000152'), null);

  // Nenhum arquivo com esse documento.
  assert.equal(casarPorDocumento(['OUTRA 11222333000181.pfx'], '56049783000152'), null);

  // Documento incompleto não pode casar por acidente.
  assert.equal(casarPorDocumento(['EMP 56049783000152.pfx'], '5604'), null);
});

// --- Receita do CNDT -------------------------------------------------------

test('a receita do CNDT passa pela tela inicial antes do formulário', async () => {
  const { RECEITAS } = await import('../src/receitas/index.js');
  const cndt = RECEITAS.cndt;

  // A entrada do portal só tem botões; o campo do documento está adiante.
  assert.equal(cndt.preparacao.length, 1);
  assert.match(cndt.preparacao[0].candidatos.join(' '), /Emitir Certidão/);
});

test('o CNDT não se ancora nos ids gerados pelo JSF', async () => {
  const { RECEITAS } = await import('../src/receitas/index.js');
  const todos = JSON.stringify(RECEITAS.cndt);

  // "j_id_jsp_992698495_2:..." muda a cada implantação do portal; um seletor
  // preso a ele passaria hoje e quebraria em silêncio na próxima atualização.
  assert.doesNotMatch(todos, /j_id_jsp/);
});

// --- Detecção de captcha ---------------------------------------------------

test('campo de resposta visível denuncia o desafio que a geometria não pega', async (t) => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return t.skip('Playwright indisponível');
  }

  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  let navegador;
  try {
    navegador = await chromium.launch({
      args: ['--no-sandbox'],
      ...(executablePath ? { executablePath } : {}),
    });
  } catch {
    return t.skip('Chromium indisponível');
  }

  const { detectarCaptcha } = await import('../src/provedores/web.js');
  const pagina = await navegador.newPage();

  try {
    // O arranjo do CNDT: reCAPTCHA de fato invisível ao lado de um desafio
    // próprio, com campo de resposta e botão "Ouvir". Medir só o widget
    // declarava o portal automatizável quando ele não é.
    await pagina.setContent(`
      <div id="recaptcha-token" style="width:1px;height:1px"></div>
      <label>Digite os caracteres</label>
      <input type="text" id="idCampoResposta" style="width:200px;height:30px">
      <button>Ouvir</button>
    `);

    const achado = await detectarCaptcha(pagina);
    assert.equal(achado.bloqueante, true, 'o desafio precisa bloquear a automação');
    assert.match(achado.seletor, /resposta/i);
  } finally {
    await navegador.close();
  }
});

// --- Calibração sem cadastro ----------------------------------------------

test('a ajuda da calibração anuncia o caminho sem cadastro', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');

  const { stderr } = await promisify(execFile)(process.execPath, ['src/calibrar.js'], {
    cwd: new URL('..', import.meta.url).pathname,
  }).catch((e) => e);

  assert.match(stderr, /--documento <CNPJ>/);
  assert.match(stderr, /sem cadastrar/);
});

test('o erro de cadastro vazio aponta a saída, em vez de só reclamar', async () => {
  const fonte = await readFile(new URL('../src/calibrar.js', import.meta.url), 'utf8');
  // Quem tenta calibrar com a carteira vazia precisa descobrir ali mesmo que
  // existe `--documento`; antes o erro era um beco sem saída.
  assert.match(fonte, /Use --documento <CNPJ> para calibrar sem cadastrar/);
});

// --- Consulta avulsa gravada ----------------------------------------------

test('a consulta avulsa entra no índice mas fica fora da comparação mensal', async () => {
  const { escreverIndice, listarCompetencias, carregarAnterior } = await import(
    '../src/historico.js'
  );
  const pasta = await mkdtemp(join(tmpdir(), 'hist-'));

  const corpo = (n) => JSON.stringify({ geradoEm: '2026-08-06T00:00:00Z', resumo: { clientes: n } });
  await writeFile(join(pasta, '2026-07.json'), corpo(20));
  await writeFile(join(pasta, '2026-08.json'), corpo(20));
  await writeFile(join(pasta, 'avulso-56049783000152-2026-08-06.json'), corpo(1));

  const indice = await escreverIndice(pasta);
  const rotulos = indice.map((e) => e.competencia);
  assert.ok(rotulos.includes('avulso-56049783000152-2026-08-06'), 'o painel precisa listá-la');
  assert.ok(rotulos.includes('2026-08'));

  // Mas ela não pode ser o "mês anterior" de nada: compararia vinte clientes
  // com um CNPJ solto e inventaria dezenas de mudanças.
  assert.deepEqual(await listarCompetencias(pasta), ['2026-07', '2026-08']);
  const anterior = await carregarAnterior(pasta, '2026-08');
  assert.equal(anterior.competencia, '2026-07');
});

test('o rótulo da consulta avulsa carrega documento e data', async () => {
  const { rotuloAvulso } = await import('../src/index.js');
  assert.equal(
    rotuloAvulso('56.049.783/0001-52', new Date('2026-08-06T12:00:00Z')),
    'avulso-56049783000152-2026-08-06',
  );
});

// --- Qual certificado é de quem ------------------------------------------

test('a escolha do operador vence o palpite pelo nome do arquivo', async () => {
  const { escolherCertificado } = await import('../src/vinculos.js');

  // Nomes como as certificadoras realmente entregam: número do pedido, não
  // CNPJ. Deduzir aqui dizia "não existe certificado" com o arquivo na pasta.
  const arquivos = ['CERTIFICADO A1 34151051.pfx', 'TOCA DA ONCA 2026.pfx'];

  assert.equal(escolherCertificado(arquivos, '56049783000152', {}), null);
  assert.equal(
    escolherCertificado(arquivos, '56049783000152', { '56049783000152': 'TOCA DA ONCA 2026.pfx' }),
    'TOCA DA ONCA 2026.pfx',
  );
});

test('o vínculo salvo tem precedência mesmo quando o nome casaria', async () => {
  const { escolherCertificado } = await import('../src/vinculos.js');

  // Renovação: o arquivo velho tem o CNPJ no nome, o novo não. Quem sabe qual
  // vale é o operador.
  const arquivos = ['EMP 56049783000152 2025.pfx', 'renovado-2026.pfx'];
  assert.equal(
    escolherCertificado(arquivos, '56049783000152', { '56049783000152': 'renovado-2026.pfx' }),
    'renovado-2026.pfx',
  );
});

test('vínculo apontando para arquivo que sumiu não é usado', async () => {
  const { escolherCertificado } = await import('../src/vinculos.js');
  assert.equal(
    escolherCertificado(['outro.pfx'], '56049783000152', { '56049783000152': 'apagado.pfx' }),
    null,
  );
});

test('o vínculo guarda o arquivo, nunca a senha', async () => {
  const { gravarVinculo, lerVinculos } = await import('../src/vinculos.js');
  const raiz = await mkdtemp(join(tmpdir(), 'vinc-'));

  await gravarVinculo('56.049.783/0001-52', 'TOCA DA ONCA 2026.pfx', raiz);
  const gravado = await readFile(join(raiz, 'vinculos.json'), 'utf8');

  assert.deepEqual(await lerVinculos(raiz), { 56049783000152: 'TOCA DA ONCA 2026.pfx' });
  assert.doesNotMatch(gravado, /senha/i);
});
