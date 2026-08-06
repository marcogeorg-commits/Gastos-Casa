import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { criarServidor, resolverCaminho } from '../src/servidor.js';
import { validar } from '../src/documentos.js';

const RAIZ = resolve(import.meta.dirname, '..');

/**
 * Raiz de teste com cadastro próprio.
 *
 * Estes testes liam o `clientes.json` do repositório -- que hoje é a carteira
 * real do escritório e está fora do versionamento. Sem o arquivo, o painel
 * abria vazio, a linha de cliente não existia e o teste falhava por falta de
 * dado, não por defeito. Pior: a checagem "tem cliente?" passava à toa, porque
 * a linha de "nenhum cliente" também é um `<tr>`.
 *
 * O `painel/` é ligado por symlink porque o servidor entrega os estáticos a
 * partir da mesma raiz de onde lê o cadastro.
 */
/**
 * Porta que o servidor e a checagem de origem vão concordar.
 *
 * O servidor recusa POST cuja `Origin` não bata com a porta que recebeu ao ser
 * criado -- e `criarServidor(raiz)` sem porta assume a padrão. Escutando em
 * porta sorteada, o navegador mandava `Origin` de uma porta e o servidor
 * esperava outra: 403 em toda gravação. Fixar a porta antes de criar resolve.
 */
async function portaLivre() {
  const { createServer } = await import('node:net');
  const sonda = createServer();
  await new Promise((ok) => sonda.listen(0, '127.0.0.1', ok));
  const { port } = sonda.address();
  await new Promise((ok) => sonda.close(ok));
  return port;
}

async function raizComCadastro(cadastro) {
  const raiz = await mkdtemp(join(tmpdir(), 'cnd-painel-'));
  await symlink(resolve(RAIZ, 'painel'), join(raiz, 'painel'), 'dir');
  await writeFile(join(raiz, 'clientes.json'), JSON.stringify(cadastro, null, 2), 'utf8');
  return raiz;
}

const CADASTRO = {
  provedorPadrao: 'mock',
  certidoes: ['rfb_pgfn', 'fgts_crf', 'cndt', 'sefaz_sc'],
  clientes: [
    { nome: 'Alfa Comércio Ltda', documento: '11.222.333/0001-81', municipio: 'Blumenau', uf: 'SC' },
    { nome: 'João da Silva', documento: '123.456.780-62' },
  ],
};

test('nenhum caminho resolvido escapa da pasta servida', () => {
  // A propriedade que importa é contenção, não a forma da recusa: o caminho ou
  // é null, ou aponta para dentro da raiz. Um servidor de conveniência não pode
  // virar a porta de saída do disco.
  const ataques = [
    '/../../etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
    '/painel/../../../segredo',
    '//etc/shadow',
    '/./../.ssh/id_rsa',
    '/painel/..\\..\\windows\\system32',
  ];

  for (const ataque of ataques) {
    const destino = resolverCaminho(ataque, RAIZ);
    if (destino === null) continue;
    assert.ok(
      destino === RAIZ || destino.startsWith(`${RAIZ}/`),
      `"${ataque}" escapou para ${destino}`,
    );
  }
});

test('resolve os caminhos legítimos do painel', () => {
  assert.equal(resolverCaminho('/historico/index.json', RAIZ), resolve(RAIZ, 'historico/index.json'));
  assert.equal(resolverCaminho('/', RAIZ), resolve(RAIZ, 'painel/index.html'));
  assert.equal(resolverCaminho('/painel/index.html?v=2', RAIZ), resolve(RAIZ, 'painel/index.html'));
});

describe('painel no navegador', async () => {
  let navegador;
  let servidor;
  let base;
  let raiz;

  before(async () => {
    try {
      const { chromium } = await import('playwright');
      navegador = await chromium.launch({
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
          : {}),
        args: ['--no-sandbox'],
      });
      raiz = await raizComCadastro(CADASTRO);
      const porta = await portaLivre();
      servidor = criarServidor(raiz, porta);
      await new Promise((ok) => servidor.listen(porta, '127.0.0.1', ok));
      base = `http://127.0.0.1:${porta}`;
    } catch {
      navegador = null;
    }
  });

  after(async () => {
    await navegador?.close().catch(() => {});
    servidor?.close();
  });

  /**
   * Abre o painel já na aba de clientes.
   *
   * O painel abre em "Consulta rápida", e o cadastro fica atrás de uma aba --
   * `#acrescentar` existe no HTML desde o começo, mas escondido. Sem o clique,
   * a espera olhava um botão que nunca ficaria visível e estourava o prazo.
   */
  async function abrir() {
    const pagina = await navegador.newPage();
    await pagina.goto(base);
    await pagina.click('.aba[data-painel="clientes"]');
    await pagina.waitForSelector('#acrescentar');
    return pagina;
  }

  test('carrega as abas e o cadastro de clientes', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const pagina = await abrir();
    // O número acompanha as abas de painel/index.html; muda quando uma entra.
    assert.equal(await pagina.locator('.aba').count(), 5);
    // Contagem exata, não "> 0": a linha de "nenhum cliente" também é um <tr>,
    // então "> 0" passava mesmo com o cadastro vazio.
    assert.equal(
      await pagina.locator('#painel-clientes tbody tr').count(),
      CADASTRO.clientes.length,
      'cada cliente do cadastro vira uma linha',
    );

    // Sem execuções ainda, a aba mostra o cartão "Sem histórico" no lugar da
    // tabela — o teste não pode depender de o repositório já ter rodado.
    await pagina.click('.aba[data-painel="competencias"]');
    await pagina.waitForSelector('#painel-competencias .cartao');
    assert.equal(await pagina.locator('#painel-clientes').isHidden(), true);
    await pagina.close();
  });

  test('acusa documento inválido enquanto se digita', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const pagina = await abrir();
    await pagina.click('#acrescentar');

    // Escopo na linha nova: outras linhas podem ter erro de município.
    const linha = pagina.locator('#painel-clientes tbody tr').last();
    await linha.locator('[data-campo="documento"]').fill('11.222.333/0001-99');
    await linha.locator('.erro-campo').first().waitFor();
    assert.match(
      await linha.locator('td').nth(1).locator('.erro-campo').textContent(),
      /dígito verificador/,
    );

    await pagina.locator('[data-campo="documento"]').last().fill('11.222.333/0001-81');
    await pagina.waitForFunction(() => !document.querySelector('input.invalido'));
    await pagina.close();
  });

  /**
   * O painel reimplementa a validação de documento porque é uma página estática
   * sem etapa de build. Se as duas divergirem, o cadastro aceitaria o que a
   * rotina rejeita -- e o cliente sumiria do relatório sem ninguém notar.
   */
  test('a validação do painel concorda com a da rotina', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const casos = [
      '11.222.333/0001-81', '11.222.333/0001-99', '123.456.780-62', '123.456.780-63',
      '111.111.111-11', '00.000.000/0000-00', '12ABC34501DE35', 'nada disso', '',
    ];

    const pagina = await abrir();
    await pagina.click('#acrescentar');

    for (const caso of casos) {
      const campo = pagina.locator('[data-campo="documento"]').last();
      await campo.fill(caso);
      // O painel marca o campo como inválido; vazio não é erro em nenhum dos dois.
      const painelRejeita = await pagina.locator('input.invalido').count() > 0;
      const rotinaRejeita = caso !== '' && !validar(caso);

      assert.equal(
        painelRejeita,
        rotinaRejeita,
        `divergência em "${caso}": painel ${painelRejeita ? 'rejeita' : 'aceita'}, rotina ${rotinaRejeita ? 'rejeita' : 'aceita'}`,
      );
    }
    await pagina.close();
  });

  test('certidão que não se aplica ao tipo de documento fica desabilitada', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const pagina = await abrir();
    await pagina.click('#acrescentar');
    await pagina.locator('[data-campo="documento"]').last().fill('123.456.780-62');
    await pagina.waitForFunction(() => !document.querySelector('input.invalido'));

    const linha = pagina.locator('#painel-clientes tbody tr').last();
    const estadual = linha.locator('[data-certidao="sefaz_sc"]');
    assert.match(await estadual.getAttribute('style'), /pointer-events:none/);

    const federal = linha.locator('[data-certidao="rfb_pgfn"]');
    assert.doesNotMatch((await federal.getAttribute('style')) ?? '', /pointer-events:none/);
    await pagina.close();
  });

  /**
   * O clique tem de chegar ao disco.
   *
   * A versão anterior conferia um rascunho em `localStorage` -- que o painel
   * deixou de usar quando passou a gravar direto no `clientes.json` pela API.
   * O teste seguia "passando" no papel e não olhava mais nada; só apareceu
   * quando o Chromium ficou disponível e ele pôde de fato rodar.
   *
   * O que importa é o arquivo: é ele que a rotina lê na hora de consultar.
   */
  test('ligar certidão grava no clientes.json', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const pagina = await abrir();
    const primeira = pagina
      .locator('#painel-clientes tbody tr')
      .first()
      .locator('[data-certidao="cndt"]');
    const antes = await primeira.getAttribute('aria-pressed');

    await primeira.click();
    await pagina.waitForFunction(
      (esperado) =>
        document.querySelector('[data-certidao="cndt"]')?.getAttribute('aria-pressed') !== esperado,
      antes,
    );
    await pagina.waitForFunction(
      () => document.getElementById('estado-rodada')?.textContent === 'cadastro salvo',
    );

    const salvo = JSON.parse(await readFile(join(raiz, 'clientes.json'), 'utf8'));
    const temAgora = (salvo.clientes[0].certidoes ?? []).includes('cndt');
    assert.equal(temAgora, antes === 'false', 'o arquivo reflete o clique');
    await pagina.close();
  });
});

test('cliente sem lista própria mostra as certidões herdadas como ativas', async (t) => {
  // Nenhum cliente do cadastro define `certidoes` próprias: todos herdam a
  // lista da raiz. Exibir tudo desligado faria o painel mentir sobre o que a
  // rotina está de fato consultando.
  const { chromium } = await import('playwright').catch(() => ({}));
  if (!chromium) return t.skip('Playwright indisponível');

  const navegador = await chromium
    .launch({
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
      args: ['--no-sandbox'],
    })
    .catch(() => null);
  if (!navegador) return t.skip('Chromium indisponível');

  const servidor = criarServidor(await raizComCadastro(CADASTRO));
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));

  try {
    const pagina = await navegador.newPage();
    await pagina.goto(`http://127.0.0.1:${servidor.address().port}`);
    await pagina.evaluate(() => localStorage.clear());
    await pagina.reload();
    // O cadastro está atrás de uma aba: as linhas existem, mas escondidas.
    await pagina.click('.aba[data-painel="clientes"]');
    await pagina.waitForSelector('#painel-clientes tbody tr');

    const primeira = pagina.locator('#painel-clientes tbody tr').first();
    assert.equal(
      await primeira.locator('[data-certidao="rfb_pgfn"]').getAttribute('aria-pressed'),
      'true',
      'certidão herdada deve aparecer ligada',
    );
  } finally {
    await navegador.close().catch(() => {});
    servidor.close();
  }
});

/**
 * O painel repete o catálogo porque é uma página estática, sem etapa de build.
 * Quando uma certidão nova entra em src/catalogo.js e não entra aqui, ela some
 * do cadastro sem ninguém notar — foi o que aconteceu com a Situação Fiscal.
 */
test('o painel conhece todas as certidões e situações do catálogo', async () => {
  const { readFile } = await import('node:fs/promises');
  const { CATALOGO, SITUACOES } = await import('../src/catalogo.js');

  const html = await readFile(resolve(RAIZ, 'painel/index.html'), 'utf8');

  for (const id of Object.keys(CATALOGO)) {
    assert.ok(html.includes(`${id}:`), `certidão "${id}" não aparece no painel`);
  }
  for (const id of Object.keys(SITUACOES)) {
    assert.ok(html.includes(`${id}:`), `situação "${id}" não aparece no painel`);
  }
});
