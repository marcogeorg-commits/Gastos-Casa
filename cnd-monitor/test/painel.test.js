import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { criarServidor, resolverCaminho } from '../src/servidor.js';
import { validar } from '../src/documentos.js';

const RAIZ = resolve(import.meta.dirname, '..');

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

  before(async () => {
    try {
      const { chromium } = await import('playwright');
      navegador = await chromium.launch({
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
          : {}),
        args: ['--no-sandbox'],
      });
      servidor = criarServidor(RAIZ);
      await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
      base = `http://127.0.0.1:${servidor.address().port}`;
    } catch {
      navegador = null;
    }
  });

  after(async () => {
    await navegador?.close().catch(() => {});
    servidor?.close();
  });

  async function abrir() {
    const pagina = await navegador.newPage();
    // localStorage guarda rascunho entre sessões; cada teste começa limpo.
    await pagina.goto(base);
    await pagina.evaluate(() => localStorage.clear());
    await pagina.reload();
    await pagina.waitForSelector('#acrescentar');
    return pagina;
  }

  test('carrega as três abas e o cadastro de clientes', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const pagina = await abrir();
    assert.equal(await pagina.locator('.aba').count(), 3);
    assert.ok(
      (await pagina.locator('#painel-clientes tbody tr').count()) > 0,
      'clientes.json do repositório deve aparecer',
    );

    await pagina.click('.aba[data-painel="competencias"]');
    await pagina.waitForSelector('#painel-competencias table');
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

  test('ligar e desligar certidão persiste no rascunho', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const pagina = await abrir();
    const primeira = pagina.locator('#painel-clientes tbody tr').first().locator('[data-certidao="cndt"]');
    const antes = await primeira.getAttribute('aria-pressed');

    await primeira.click();
    await pagina.waitForFunction(
      (esperado) =>
        document.querySelector('[data-certidao="cndt"]').getAttribute('aria-pressed') !== esperado,
      antes,
    );

    const guardado = await pagina.evaluate(() =>
      JSON.parse(localStorage.getItem('cnd-monitor:clientes')),
    );
    const temAgora = (guardado.clientes[0].certidoes ?? []).includes('cndt');
    assert.equal(temAgora, antes === 'false', 'o rascunho reflete o clique');
    await pagina.close();
  });
});

test('cliente sem lista própria mostra as certidões herdadas como ativas', async (t) => {
  // O cadastro do repositório não define `certidoes` por cliente: todos herdam
  // a lista da raiz. Exibir tudo desligado faria o painel mentir sobre o que a
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

  const servidor = criarServidor(RAIZ);
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));

  try {
    const pagina = await navegador.newPage();
    await pagina.goto(`http://127.0.0.1:${servidor.address().port}`);
    await pagina.evaluate(() => localStorage.clear());
    await pagina.reload();
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
