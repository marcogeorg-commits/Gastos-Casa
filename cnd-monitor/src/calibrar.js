#!/usr/bin/env node
/**
 * Calibração de seletores.
 *
 * Abre o portal de uma certidão, lista os campos e botões que existem de fato e
 * diz se há captcha. Serve para preencher `src/receitas/index.js` sem adivinhar:
 *
 *   npm run calibrar -- rfb_pgfn
 *   npm run calibrar -- rfb_pgfn --tipo cpf
 *   npm run calibrar -- cndt --headed
 *
 * Precisa rodar de uma máquina com acesso aos portais (o ambiente do agente e
 * os runners do GitHub Actions costumam não ter).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDS_RECEITAS, RECEITAS } from './receitas/index.js';
import { detectarCaptcha, esperarSeletor } from './provedores/web.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ESPERA_APP = 30_000;

/**
 * Espera o app renderizar algum controle.
 *
 * Sem isso o inventário fotografa a página no instante do `goto` -- num SPA,
 * antes de existir formulário -- e conclui, errado, que o portal não tem campo
 * nenhum. Usa locator (que atravessa shadow DOM) em vez de querySelector.
 */
export async function esperarApp(pagina, tempoLimite = ESPERA_APP) {
  await pagina.waitForLoadState('networkidle').catch(() => {});
  try {
    await pagina
      .locator('input:not([type=hidden]), select, textarea, button')
      .first()
      .waitFor({ state: 'attached', timeout: tempoLimite });
    return true;
  } catch {
    return false;
  }
}

/**
 * Inventário dos controles interativos, atravessando shadow DOM.
 *
 * `document.querySelectorAll` não enxerga dentro de shadow roots; componentes do
 * design system do gov.br podem usá-los. Um campo invisível ao inventário mas
 * visível ao Playwright levaria a diagnóstico errado.
 */
export async function inventariar(pagina) {
  return pagina.evaluate(() => {
    const descrever = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      id: el.id || null,
      name: el.getAttribute('name'),
      formcontrolname: el.getAttribute('formcontrolname'),
      placeholder: el.getAttribute('placeholder'),
      aria: el.getAttribute('aria-label'),
      texto: (el.innerText || el.value || '').trim().slice(0, 60) || null,
      seletor: el.id
        ? `#${CSS.escape(el.id)}`
        : el.getAttribute('formcontrolname')
          ? `${el.tagName.toLowerCase()}[formcontrolname="${el.getAttribute('formcontrolname')}"]`
          : el.getAttribute('name')
            ? `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`
            : null,
    });

    const campos = [];
    const botoes = [];
    const tagsCustomizadas = new Set();

    const percorrer = (raiz) => {
      for (const el of raiz.querySelectorAll('*')) {
        if (el.tagName.includes('-')) tagsCustomizadas.add(el.tagName.toLowerCase());
        if (el.matches('input, select, textarea') && el.type !== 'hidden') {
          campos.push(descrever(el));
        }
        if (el.matches('button, input[type=submit], a[role=button]')) botoes.push(descrever(el));
        if (el.shadowRoot) percorrer(el.shadowRoot);
      }
    };
    percorrer(document);

    return {
      titulo: document.title,
      campos,
      botoes,
      tagsCustomizadas: [...tagsCustomizadas],
      iframes: [...document.querySelectorAll('iframe')].map((el) => el.src),
      // Fallback de diagnóstico: se nada foi encontrado, o texto da página diz
      // se caiu numa tela de erro, de manutenção ou de login.
      textoVisivel: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
      html: document.documentElement.outerHTML.length,
    };
  });
}

export async function calibrar(idCertidao, opcoes = {}) {
  const receita = RECEITAS[idCertidao];
  if (!receita) {
    throw new Error(
      `Sem receita para "${idCertidao}". Disponíveis: ${IDS_RECEITAS.join(', ')}.`,
    );
  }

  const { chromium } = await import('playwright');
  const navegador = await chromium.launch({
    headless: !opcoes.headed,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox'],
  });

  try {
    const pagina = await navegador.newPage({ locale: 'pt-BR' });
    pagina.setDefaultTimeout(45_000);

    // Percorre todas as URLs da receita e fica na primeira que abrir: o
    // diagnóstico precisa dizer qual endereço ainda está de pé.
    const urls = receita.urlsPara?.({ tipo: opcoes.tipo ?? 'cnpj' }) ?? receita.urls;
    let urlAberta = null;
    for (const url of urls) {
      process.stdout.write(`Abrindo ${url} ... `);
      try {
        const resposta = await pagina.goto(url, { waitUntil: 'domcontentloaded' });
        console.log(`HTTP ${resposta?.status() ?? '?'}`);
        urlAberta = url;
        break;
      } catch (erro) {
        console.log(`falhou (${erro.message.split('\n')[0]})`);
      }
    }

    if (!urlAberta) {
      throw new Error('Nenhuma URL da receita abriu a partir desta máquina.');
    }

    process.stdout.write('Esperando o app renderizar ... ');
    const renderizou = await esperarApp(pagina);
    console.log(renderizou ? 'ok' : `nada apareceu em ${ESPERA_APP / 1000}s`);

    const captcha = await detectarCaptcha(pagina);
    const inventario = await inventariar(pagina);

    console.log(`\nURL: ${urlAberta}`);
    console.log(`Título: ${inventario.titulo}`);
    console.log(
      captcha
        ? `Captcha detectado: ${captcha.provedor} ${
            captcha.bloqueante ? 'VISÍVEL (bloqueia a automação)' : 'invisível'
          } — ${captcha.seletor}`
        : 'Sem captcha aparente.',
    );

    console.log(`\nCampos (${inventario.campos.length}):`);
    for (const c of inventario.campos) {
      const rotulo = c.placeholder ?? c.aria ?? '';
      console.log(`  ${c.seletor ?? '(sem id/name)'}  ${c.type ?? c.tag}  ${rotulo}`);
    }

    console.log(`\nBotões (${inventario.botoes.length}):`);
    for (const b of inventario.botoes) {
      console.log(`  ${b.seletor ?? '(sem id/name)'}  "${b.texto ?? ''}"`);
    }

    if (inventario.tagsCustomizadas.length > 0) {
      console.log(`\nComponentes: ${inventario.tagsCustomizadas.slice(0, 20).join(', ')}`);
    }
    if (inventario.iframes.length > 0) {
      console.log(`\nIframes: ${inventario.iframes.join(', ')}`);
    }

    // Sem controle nenhum, o texto da página é o que explica o porquê.
    if (inventario.campos.length === 0 && inventario.botoes.length === 0) {
      console.log(`\nA página não expôs controles. Texto visível:\n  ${inventario.textoVisivel}`);
      console.log(`  (HTML com ${inventario.html} caracteres)`);
    }

    console.log('\nSeletores da receita atual:');
    for (const [papel, candidatos] of Object.entries(receita.seletores)) {
      // Espera curta: o elemento pode aparecer depois do primeiro render.
      const encontrado = await esperarSeletor(pagina, candidatos, 3000);
      console.log(`  ${papel}: ${encontrado ? `OK → ${encontrado}` : 'NENHUM candidato casou'}`);
    }

    const pasta = resolve(RAIZ, 'calibracao');
    await mkdir(pasta, { recursive: true });
    await pagina.screenshot({ path: resolve(pasta, `${idCertidao}.png`), fullPage: true });
    await writeFile(
      resolve(pasta, `${idCertidao}.json`),
      `${JSON.stringify({ url: urlAberta, urlsTentadas: urls, captcha, ...inventario }, null, 2)}\n`,
      'utf8',
    );
    console.log(`\nInventário e captura salvos em calibracao/${idCertidao}.*`);

    return { captcha, ...inventario };
  } finally {
    await navegador.close().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const idCertidao = argv.find((a) => !a.startsWith('--'));
  const headed = argv.includes('--headed');
  const tipo = argv[argv.indexOf('--tipo') + 1];

  if (!idCertidao) {
    console.error(`Uso: npm run calibrar -- <certidao>\nDisponíveis: ${IDS_RECEITAS.join(', ')}`);
    process.exit(1);
  }

  calibrar(idCertidao, { headed, tipo: argv.includes('--tipo') ? tipo : undefined }).catch((erro) => {
    console.error(`Erro: ${erro.message}`);
    process.exit(1);
  });
}
