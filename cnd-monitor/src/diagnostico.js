#!/usr/bin/env node
/**
 * Diagnóstico de uma consulta, passo a passo, sem resumo.
 *
 * A consulta normal devolve um veredito: "falha na consulta", "portal recusou".
 * Isso serve para o relatório e não serve para descobrir o que houve. Este
 * comando faz o caminho inteiro narrando cada etapa e guarda tudo em arquivo.
 *
 * O que ele registra e a consulta normal não:
 *
 * - **cada chamada de rede do portal, com o corpo da resposta**. É aí que mora
 *   o "023" da Receita: a página só exibe a frase, mas quem a produziu foi uma
 *   resposta de API que ninguém estava lendo. Sem isso, discutir a causa é
 *   adivinhação -- foi o que fizemos por horas.
 * - erros de JavaScript da própria página, que somem quando a janela fecha;
 * - o que ficou de fato no campo do documento, depois da máscara;
 * - o que cada passo de preparação encontrou, clicou, e se sumiu da tela;
 * - a tela e o HTML no fim, dê certo ou não.
 *
 *   npm run diagnostico -- --documento 42160865000165
 *   npm run diagnostico -- --documento 42160865000165 --certidao cndt
 *
 * O arquivo tem CNPJ de cliente e resposta do órgão: fica em `diagnostico/`,
 * fora do versionamento. Mande-o por onde já manda documento de cliente.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECEITAS } from './receitas/index.js';
import { formatar, limpar, tipoDocumento, validar } from './documentos.js';
import { chamadoDireto } from './executavel.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIMITE_CORPO = 4000;

/** Junta as linhas na ordem em que aconteceram, com o relógio de cada uma. */
export function criarDiario(agora = () => new Date()) {
  const linhas = [];
  const inicio = agora();

  const escrever = (texto) => {
    const s = Math.round((agora() - inicio) / 100) / 10;
    linhas.push(`[${String(s).padStart(6)}s] ${texto}`);
    console.log(texto);
  };

  return {
    escrever,
    secao: (titulo) => {
      linhas.push('');
      escrever(`── ${titulo} ${'─'.repeat(Math.max(0, 60 - titulo.length))}`);
    },
    texto: () => linhas.join('\n'),
  };
}

/**
 * Resposta de API interessa; imagem, fonte e script, não.
 *
 * Sem esse filtro o arquivo vira um despejo de centenas de recursos estáticos
 * e a resposta que explica o erro se perde no meio.
 */
export function vaiParaODiario(url, tipo) {
  if (/\.(png|jpe?g|gif|svg|woff2?|ttf|css|ico)(\?|$)/i.test(url)) return false;
  if (tipo === 'image' || tipo === 'font' || tipo === 'stylesheet' || tipo === 'script') {
    return false;
  }
  if (/hcaptcha|recaptcha|google-analytics|gtm\.js/i.test(url)) return false;
  return true;
}

async function abrir(headless) {
  const { chromium } = await import('playwright');
  return chromium.launch({
    headless,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox'],
  });
}

export async function diagnosticar(documento, idCertidao = 'rfb_pgfn', opcoes = {}) {
  const bruto = limpar(documento);
  if (!validar(bruto)) throw new Error(`"${documento}" não é um CNPJ nem um CPF válido.`);

  const receita = RECEITAS[idCertidao];
  if (!receita) {
    throw new Error(`Não conheço a certidão "${idCertidao}". Conhecidas: ${Object.keys(RECEITAS).join(', ')}`);
  }

  const d = criarDiario();
  const cliente = { nome: formatar(bruto), documento: bruto, tipo: tipoDocumento(bruto) };

  d.escrever(`Diagnóstico · ${receita.nome} · ${formatar(bruto)}`);
  d.escrever(`Node ${process.version} · ${new Date().toISOString()}`);

  const navegador = await abrir(opcoes.headless ?? false);
  const contexto = await navegador.newContext({ locale: 'pt-BR', acceptDownloads: true });
  const pagina = await contexto.newPage();
  pagina.setDefaultTimeout(60_000);

  // --- tudo que a página disser sobre si mesma -----------------------------
  pagina.on('console', (m) => d.escrever(`  console.${m.type()}: ${m.text().slice(0, 300)}`));
  pagina.on('pageerror', (e) => d.escrever(`  ERRO DE PÁGINA: ${e.message}`));
  pagina.on('requestfailed', (r) =>
    d.escrever(`  REQUISIÇÃO FALHOU: ${r.method()} ${r.url().slice(0, 160)} — ${r.failure()?.errorText}`),
  );
  pagina.on('download', (dl) => d.escrever(`  DOWNLOAD: ${dl.suggestedFilename()}`));

  pagina.on('response', async (r) => {
    const url = r.url();
    if (!vaiParaODiario(url, r.request().resourceType())) return;

    const marca = r.status() >= 400 ? 'RESPOSTA COM ERRO' : 'resposta';
    d.escrever(`  ${marca}: ${r.status()} ${r.request().method()} ${url.slice(0, 160)}`);

    // O corpo e o que explica o "023": a pagina so exibe a frase, quem a
    // produziu foi esta resposta.
    if (r.request().method() === 'GET' && r.status() < 400 && !/\/api\/|servico/i.test(url)) return;
    const corpo = await r.text().catch(() => null);
    if (corpo && corpo.length < 200_000) {
      d.escrever(`    corpo: ${corpo.replace(/\s+/g, ' ').slice(0, LIMITE_CORPO)}`);
    }
  });

  const urls = receita.urlsPara?.(cliente) ?? receita.urls ?? [receita.url];
  let arquivo = null;

  try {
    d.secao('Abrindo o portal');
    for (const url of urls) {
      d.escrever(`Tentando ${url}`);
      const resposta = await pagina.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => {
        d.escrever(`  não abriu: ${e.message}`);
        return null;
      });
      if (resposta) {
        d.escrever(`  HTTP ${resposta.status()} — ${pagina.url()}`);
        break;
      }
    }

    await pagina.waitForLoadState('networkidle').catch(() => {});
    d.escrever(`Título: "${await pagina.title().catch(() => '')}"`);

    d.secao('Passos de preparação (avisos, cookies)');
    const { primeiroVisivel, esperarSeletor } = await import('./provedores/web.js');
    for (const passo of receita.preparacao ?? []) {
      const nome = passo.descricao ?? passo.nome ?? '(sem nome)';
      const alvo = await primeiroVisivel(pagina, passo.candidatos);
      if (!alvo) {
        d.escrever(`${nome}: nenhum candidato visível — seguindo`);
        continue;
      }
      const rotulo = (await alvo.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim();
      d.escrever(`${nome}: clicando em "${rotulo?.slice(0, 60)}"`);
      await alvo.click({ timeout: 5000 }).catch((e) => d.escrever(`  clique falhou: ${e.message}`));
      await alvo.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      const aindaLa = await alvo.isVisible().catch(() => false);
      d.escrever(`  ${aindaLa ? 'AINDA NA TELA — vai cobrir o que estiver embaixo' : 'sumiu da tela'}`);
    }

    d.secao('Inventário da tela');
    const { inventariar } = await import('./inventario.js');
    const inv = await inventariar(pagina);
    d.escrever(`Botões (${inv.botoes.length}):`);
    for (const b of inv.botoes) d.escrever(`  ${b.seletor ?? b.tag} · "${b.texto ?? b.aria ?? ''}"`);
    d.escrever(`Campos (${inv.campos.length}):`);
    for (const c of inv.campos) d.escrever(`  ${c.seletor ?? c.tag} · "${c.placeholder ?? c.aria ?? ''}"`);

    d.secao('Preenchendo o documento');
    const { escreverDocumento } = await import('./receitas/index.js');
    const campo = await esperarSeletor(pagina, receita.seletores.campoDocumento);
    if (!campo) {
      d.escrever('CAMPO NÃO ENCONTRADO — os candidatos não casaram com nada nesta tela.');
    } else {
      d.escrever(`Campo: ${campo}`);
      const valor = receita.seletores && RECEITAS[idCertidao] ? bruto : bruto;
      const escrita = await escreverDocumento(pagina, campo, valor, bruto);
      d.escrever(`Ficou no campo: "${await pagina.inputValue(campo).catch(() => '?')}"`);
      d.escrever(escrita.ok ? 'Confere com o documento.' : `NÃO CONFERE: "${escrita.encontrado}"`);
    }

    d.secao('Enviando');
    const botao = await esperarSeletor(pagina, receita.seletores.botaoEnviar);
    if (!botao) {
      d.escrever('BOTÃO DE ENVIO NÃO ENCONTRADO.');
    } else {
      d.escrever(`Botão: ${botao}`);
      await pagina.click(botao, { timeout: 15_000 }).catch((e) => d.escrever(`CLIQUE FALHOU: ${e.message}`));
      d.escrever('Clicado. Esperando a resposta do portal...');
      await pagina.waitForLoadState('networkidle').catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
    }

    d.secao('Como a tela ficou');
    d.escrever(`URL: ${pagina.url()}`);
    d.escrever(`Título: "${await pagina.title().catch(() => '')}"`);
    const texto = await pagina
      .evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim())
      .catch(() => '');
    d.escrever(`Texto da página (${texto.length} caracteres):`);
    d.escrever(texto.slice(0, 3000));

    const pasta = resolve(RAIZ, 'diagnostico');
    await mkdir(pasta, { recursive: true });
    const base = `${idCertidao}-${bruto}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await pagina.screenshot({ path: resolve(pasta, `${base}.png`), fullPage: true }).catch(() => {});
    await writeFile(resolve(pasta, `${base}.html`), await pagina.content().catch(() => ''), 'utf8');

    arquivo = resolve(pasta, `${base}.log`);
    await writeFile(arquivo, d.texto(), 'utf8');

    console.log(`\n  Diário completo: ${arquivo}`);
    console.log(`  Tela:            ${resolve(pasta, `${base}.png`)}`);
    console.log(`  HTML:            ${resolve(pasta, `${base}.html`)}\n`);
  } finally {
    if (opcoes.manterAberto !== false) {
      console.log('  A janela fica aberta. Feche-a quando terminar de olhar.\n');
      const ate = Date.now() + 300_000;
      while (Date.now() < ate && !pagina.isClosed()) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await navegador.close().catch(() => {});
  }

  return arquivo;
}

function lerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const chave = argv[i].slice(2);
    const valor = argv[i + 1]?.startsWith('--') ? true : argv[i + 1];
    args[chave] = valor ?? true;
  }
  return args;
}

if (chamadoDireto(import.meta.url)) {
  const args = lerArgumentos(process.argv.slice(2));

  if (!args.documento) {
    console.error(`
  Diagnóstico detalhado de uma consulta.

    npm run diagnostico -- --documento 42160865000165
    npm run diagnostico -- --documento 42160865000165 --certidao cndt

  Certidões: ${Object.keys(RECEITAS).join(', ')}
`);
    process.exit(1);
  }

  await diagnosticar(String(args.documento), String(args.certidao ?? 'rfb_pgfn'), {
    headless: args.janela === 'nao',
  });
}
