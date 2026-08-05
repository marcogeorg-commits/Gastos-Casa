#!/usr/bin/env node
/**
 * Calibração de seletores.
 *
 * Abre o portal de uma certidão, lista os campos e botões que existem de fato e
 * diz se há captcha. Serve para preencher `src/receitas/index.js` sem adivinhar:
 *
 *   npm run calibrar -- rfb_pgfn
 *   npm run calibrar -- cndt --headed
 *
 * Precisa rodar de uma máquina com acesso aos portais (o ambiente do agente e
 * os runners do GitHub Actions costumam não ter).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDS_RECEITAS, RECEITAS } from './receitas/index.js';
import { detectarCaptcha, primeiroSeletorPresente } from './provedores/web.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Inventário dos controles interativos da página, como o DOM realmente está. */
async function inventariar(pagina) {
  return pagina.evaluate(() => {
    const descrever = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      id: el.id || null,
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      texto: (el.innerText || el.value || '').trim().slice(0, 60) || null,
      seletor: el.id
        ? `#${CSS.escape(el.id)}`
        : el.getAttribute('name')
          ? `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`
          : null,
    });

    return {
      titulo: document.title,
      campos: [...document.querySelectorAll('input, select, textarea')]
        .filter((el) => el.type !== 'hidden')
        .map(descrever),
      botoes: [...document.querySelectorAll('button, input[type=submit], a[role=button]')].map(
        descrever,
      ),
      iframes: [...document.querySelectorAll('iframe')].map((el) => el.src),
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
    let urlAberta = null;
    for (const url of receita.urls) {
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

    const captcha = await detectarCaptcha(pagina);
    const inventario = await inventariar(pagina);

    console.log(`\nURL: ${urlAberta}`);
    console.log(`Título: ${inventario.titulo}`);
    console.log(captcha ? `Captcha detectado: ${captcha}` : 'Sem captcha aparente.');

    console.log('\nCampos:');
    for (const c of inventario.campos) {
      console.log(`  ${c.seletor ?? '(sem id/name)'}  ${c.type ?? c.tag}  ${c.placeholder ?? ''}`);
    }

    console.log('\nBotões:');
    for (const b of inventario.botoes) {
      console.log(`  ${b.seletor ?? '(sem id/name)'}  "${b.texto ?? ''}"`);
    }

    console.log('\nSeletores da receita atual:');
    for (const [papel, candidatos] of Object.entries(receita.seletores)) {
      const encontrado = await primeiroSeletorPresente(pagina, candidatos);
      console.log(`  ${papel}: ${encontrado ? `OK → ${encontrado}` : 'NENHUM candidato casou'}`);
    }

    const pasta = resolve(RAIZ, 'calibracao');
    await mkdir(pasta, { recursive: true });
    await pagina.screenshot({ path: resolve(pasta, `${idCertidao}.png`), fullPage: true });
    await writeFile(
      resolve(pasta, `${idCertidao}.json`),
      `${JSON.stringify({ url: urlAberta, urlsTentadas: receita.urls, captcha, ...inventario }, null, 2)}\n`,
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

  if (!idCertidao) {
    console.error(`Uso: npm run calibrar -- <certidao>\nDisponíveis: ${IDS_RECEITAS.join(', ')}`);
    process.exit(1);
  }

  calibrar(idCertidao, { headed }).catch((erro) => {
    console.error(`Erro: ${erro.message}`);
    process.exit(1);
  });
}
