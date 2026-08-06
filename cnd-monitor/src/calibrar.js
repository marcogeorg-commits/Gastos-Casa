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
 *   npm run calibrar -- cadin_federal --cliente "Alfa"   # e-CAC, com certificado
 *
 * Precisa rodar de uma máquina com acesso aos portais (o ambiente do agente e
 * os runners do GitHub Actions costumam não ter).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDS_RECEITAS, RECEITAS } from './receitas/index.js';
import { IDS_ECAC, LOGIN_ECAC, RECEITAS_ECAC } from './receitas/ecac.js';
import { detectarCaptcha, esperarSeletor, primeiroVisivel } from './provedores/web.js';
import { abrirContexto, autenticado } from './provedores/ecac.js';
import { carregarConfig } from './config.js';
import { resolverCertificado } from './certificados.js';
import { chamadoDireto } from './executavel.js';

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

/**
 * Calibração do e-CAC: entra com o certificado de um cliente e inventaria a
 * tela autenticada. Sem entrar, o inventário seria o da página de login — que
 * não tem relação com o serviço que se quer automatizar.
 */
export async function calibrarEcac(idCertidao, opcoes = {}) {
  const receita = RECEITAS_ECAC[idCertidao];
  const config = await carregarConfig(resolve(RAIZ, opcoes.clientes ?? 'clientes.json'));

  const cliente = opcoes.cliente
    ? config.clientes.find((c) => c.nome.toLowerCase().includes(opcoes.cliente.toLowerCase()))
    : config.clientes.find((c) => c.certificado);

  if (!cliente) {
    throw new Error(
      opcoes.cliente
        ? `Nenhum cliente com nome contendo "${opcoes.cliente}".`
        : 'Nenhum cliente do cadastro tem certificado configurado.',
    );
  }

  const certificado = await resolverCertificado(cliente, config, process.env);
  if (certificado.erro) throw new Error(certificado.erro);

  const { chromium } = await import('playwright');
  const navegador = await chromium.launch({
    headless: !opcoes.headed,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox'],
  });

  try {
    const contexto = await abrirContexto(navegador, certificado);
    const pagina = await contexto.newPage();
    pagina.setDefaultTimeout(60_000);

    console.log(`Cliente: ${cliente.nome} · certificado: ${certificado.caminho}`);
    process.stdout.write(`Abrindo ${LOGIN_ECAC} ... `);
    const resposta = await pagina.goto(LOGIN_ECAC, { waitUntil: 'domcontentloaded' });
    console.log(`HTTP ${resposta?.status() ?? '?'}`);

    await esperarApp(pagina);
    const entrou = await autenticado(pagina);
    console.log(entrou ? 'Sessão autenticada.' : 'NÃO autenticou — o inventário abaixo é da tela de login.');

    const inventario = await inventariar(pagina);
    console.log(`\nTítulo: ${inventario.titulo}`);
    console.log(`\nLinks de serviço que casam com a receita:`);
    for (const candidato of receita.caminhoServico) {
      const achou = (await pagina.locator(candidato).count()) > 0;
      console.log(`  ${candidato}: ${achou ? 'OK' : 'não encontrado'}`);
    }

    console.log(`\nTexto visível:\n  ${inventario.textoVisivel}`);

    const pasta = resolve(RAIZ, 'calibracao');
    await mkdir(pasta, { recursive: true });
    // Prefixo `ecac-` porque essa captura mostra a tela autenticada de um
    // cliente: o .gitignore a mantém fora do versionamento por esse nome.
    await pagina.screenshot({ path: resolve(pasta, `ecac-${idCertidao}.png`), fullPage: true });
    console.log(`\nCaptura salva em calibracao/ecac-${idCertidao}.png (fora do versionamento).`);

    return { autenticado: entrou, ...inventario };
  } finally {
    await navegador.close().catch(() => {});
  }
}

export async function calibrar(idCertidao, opcoes = {}) {
  if (RECEITAS_ECAC[idCertidao]) return calibrarEcac(idCertidao, opcoes);

  const receita = RECEITAS[idCertidao];
  if (!receita) {
    throw new Error(
      `Sem receita para "${idCertidao}". Disponíveis: ${[...IDS_RECEITAS, ...IDS_ECAC].join(', ')}.`,
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

    // Alguns portais nao mostram o formulario na entrada: o CNDT abre so com
    // "Emitir Certidao" e "Validar Certidao", e o campo do documento esta na
    // tela seguinte. Sem percorrer a preparacao, o inventario descreveria a
    // porta e nunca a sala -- foi exatamente o que aconteceu na primeira
    // calibracao dele.
    const passos = receita.preparacao ?? [];
    if (passos.length > 0) {
      console.log(`\nPreparação (${passos.length} passo${passos.length === 1 ? '' : 's'}):`);
      for (const passo of passos) {
        const alvo = await primeiroVisivel(pagina, passo.candidatos);
        if (!alvo) {
          console.log(`  ${passo.nome ?? passo.candidatos[0]} — não está na tela, pulado`);
          continue;
        }
        await alvo.click({ timeout: 5000 }).catch(() => {});
        await pagina.waitForLoadState('networkidle').catch(() => {});
        await esperarApp(pagina);
        console.log(`  ${passo.nome ?? passo.candidatos[0]} — clicado`);
      }
    }

    const captcha = await detectarCaptcha(pagina);
    const inventario = await inventariar(pagina);

    console.log(`\nURL: ${pagina.url()}`);
    console.log(`Entrada: ${urlAberta}`);
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

if (chamadoDireto(import.meta.url)) {
  const argv = process.argv.slice(2);
  const idCertidao = argv.find((a) => !a.startsWith('--'));
  const headed = argv.includes('--headed');
  const tipo = argv[argv.indexOf('--tipo') + 1];
  const cliente = argv[argv.indexOf('--cliente') + 1];

  if (!idCertidao) {
    console.error(
      `Uso: npm run calibrar -- <certidao> [--tipo cpf] [--cliente <nome>] [--headed]\n` +
        `Portais públicos: ${IDS_RECEITAS.join(', ')}\n` +
        `e-CAC (exige certificado): ${IDS_ECAC.join(', ')}`,
    );
    process.exit(1);
  }

  calibrar(idCertidao, {
    headed,
    tipo: argv.includes('--tipo') ? tipo : undefined,
    cliente: argv.includes('--cliente') ? cliente : undefined,
  }).catch((erro) => {
    console.error(`Erro: ${erro.message}`);
    process.exit(1);
  });
}
