/**
 * Provedor e-CAC — consulta autenticada com o certificado digital do cliente.
 *
 * É o caminho legítimo para o CADIN federal: a lei admite consulta por terceiro
 * munido de procuração, e no e-CAC isso se traduz em entrar com o certificado
 * do cliente (ou com procuração eletrônica dele para o escritório).
 *
 * Cada cliente tem o seu certificado, então cada consulta abre um contexto
 * próprio — contexto do navegador é onde o Playwright prende o certificado, e
 * misturá-los faria um cliente ser consultado com a credencial de outro.
 *
 * >>> Os seletores de `src/receitas/ecac.js` não foram verificados contra o
 * >>> portal. Calibre antes de usar em produção.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolverCertificado } from '../certificados.js';
import { interpretarTexto } from '../situacao.js';
import { LOGIN_ECAC, ORIGENS_CERTIFICADO, PASSOS_LOGIN, RECEITAS_ECAC } from '../receitas/ecac.js';
import { esperarSeletor, primeiroSeletorPresente, primeiroVisivel } from './web.js';

export const id = 'ecac';
export const nome = 'e-CAC (certificado digital)';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPO_LIMITE = 60_000;

export function suporta(idCertidao) {
  return Boolean(RECEITAS_ECAC[idCertidao]);
}

export function credenciaisFaltando() {
  // A credencial e por cliente, nao global: e verificada na hora da consulta.
  return [];
}

let navegador = null;

async function abrirNavegador(env) {
  if (navegador) return navegador;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'O provedor "ecac" exige o Playwright. Rode: npm install playwright && npx playwright install chromium',
    );
  }

  navegador = await chromium.launch({
    headless: env.ECAC_HEADLESS !== 'false',
    ...(env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox'],
  });
  return navegador;
}

export async function encerrar() {
  if (!navegador) return;
  await navegador.close().catch(() => {});
  navegador = null;
}

/** Contexto amarrado ao certificado de um cliente. */
export async function abrirContexto(browser, certificado) {
  return browser.newContext({
    locale: 'pt-BR',
    clientCertificates: ORIGENS_CERTIFICADO.map((origin) => ({
      origin,
      pfxPath: certificado.caminho,
      passphrase: certificado.senha,
    })),
  });
}

/**
 * Espera a pagina ter conteudo de verdade antes de olhar para ela.
 *
 * O login do e-CAC e uma aplicacao que se monta no proprio navegador: o que o
 * servidor manda e uma casca vazia, e o conteudo so aparece quando o script
 * roda. `networkidle` nao cobre isso -- portal de governo mantem chamada em
 * segundo plano, a espera nunca se cumpre, estoura o prazo em silencio (o
 * `.catch` engole) e a rotina segue olhando a casca.
 *
 * Foi exatamente esse o sintoma relatado: titulo vazio, zero links, corpo sem
 * texto, numa URL que no navegador do operador mostra a tela inteira. A pagina
 * existia; so nao tinha nascido ainda quando perguntamos.
 *
 * O criterio e grosseiro de proposito -- texto no corpo OU alguns elementos
 * clicaveis. Nao interessa QUAL tela e, so que ja exista alguma.
 */
export async function esperarConteudo(pagina, tempoLimite = 20_000) {
  try {
    await pagina.waitForFunction(
      () =>
        (document.body?.innerText ?? '').trim().length > 40 ||
        document.querySelectorAll('a, button, input').length > 2,
      undefined,
      { timeout: tempoLimite },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Marcas de que estamos DENTRO do e-CAC, nao apenas fora da tela de login.
 *
 * Um portal autenticado sempre oferece uma saida e diz de quem e a sessao.
 */
const MARCAS_DE_DENTRO = [
  'a:has-text("Sair")',
  'a[href*="logout" i]',
  'a[href*="encerrar" i]',
  'text=/perfil de acesso/i',
  'text=/contribuinte:/i',
];

const MARCAS_DE_LOGIN = [
  'text=/entrar com gov.br/i',
  'text=/sua conta gov.br/i',
  'input[type="password"]',
  'button:has-text("Certificado digital")',
  'a:has-text("Certificado digital")',
];

/**
 * Entrou de fato?
 *
 * A versao anterior respondia "sim" sempre que NAO achava marca de tela de
 * login -- e ausencia de prova nao e prova. Bastava o portal mostrar qualquer
 * outra coisa (aviso, erro, pagina intermediaria) para a rotina seguir adiante
 * achando que estava logada e falhar la na frente, com uma mensagem sobre
 * seletores que nao tinha nada a ver com o problema real.
 *
 * Agora exige marca positiva de sessao aberta.
 */
export async function autenticado(pagina) {
  if (await primeiroVisivel(pagina, MARCAS_DE_LOGIN)) return false;
  return (await primeiroVisivel(pagina, MARCAS_DE_DENTRO)) !== null;
}

/**
 * O que a tela mostra quando algo nao foi encontrado.
 *
 * Sem isto, "servico nao encontrado no menu" e um beco: nao da para saber se o
 * menu mudou, se a sessao nao abriu ou se o portal devolveu outra pagina. Com
 * a lista de links em maos, o ajuste e imediato -- e ela vai para o log, que o
 * operador ve no painel.
 */
/**
 * Percorre o caminho ate a tela autenticada.
 *
 * O e-CAC nao aceita certificado na propria pagina: manda para o SSO do
 * gov.br, e e la que o certificado e oferecido. Cada passo e opcional -- se a
 * sessao ja estiver aberta, ou se o portal pular uma etapa, o passo
 * simplesmente nao encontra o que clicar e a rotina segue.
 */
export async function entrar(pagina, registrar = () => {}) {
  if (!(await esperarConteudo(pagina))) {
    registrar('      e-CAC: a tela de login nao chegou a mostrar conteudo.');
  }

  for (const passo of PASSOS_LOGIN) {
    if (await autenticado(pagina)) return true;

    const alvo = await primeiroVisivel(pagina, passo.candidatos);
    if (!alvo) {
      registrar(`      e-CAC: "${passo.nome}" nao esta nesta tela -- seguindo.`);
      continue;
    }

    registrar(`      e-CAC: ${passo.nome}`);
    await alvo.click({ timeout: 15_000 }).catch(() => {});
    // O handshake do certificado acontece aqui, no redirecionamento -- e a tela
    // seguinte tambem se monta no navegador, entao vale a mesma espera.
    await pagina.waitForLoadState('networkidle').catch(() => {});
    await esperarConteudo(pagina);
  }

  return autenticado(pagina);
}

export async function diagnosticar(pagina, limite = 40) {
  const links = await pagina
    .evaluate(
      (max) =>
        [...document.querySelectorAll('a')]
          .map((a) => (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t.length > 2 && t.length < 80)
          .slice(0, max),
      limite,
    )
    .catch(() => []);

  // Zero link e titulo vazio nao distinguem "o menu mudou" de "nao veio pagina
  // nenhuma" -- e sao problemas opostos. O texto e o tamanho do HTML separam
  // os dois na primeira olhada.
  const texto = await pagina
    .evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 500))
    .catch(() => '');
  const tamanhoHtml = await pagina
    .evaluate(() => document.documentElement.outerHTML.length)
    .catch(() => 0);

  return {
    url: pagina.url(),
    titulo: await pagina.title().catch(() => ''),
    links,
    texto,
    tamanhoHtml,
    // Portal do governo costuma por o conteudo em iframe; procurar so no
    // documento principal acharia uma casca vazia e concluiria errado.
    quadros: pagina.frames().map((f) => f.url()).filter((u) => u && u !== 'about:blank'),
  };
}

/**
 * Guarda a tela e o HTML de uma sessao que nao abriu.
 *
 * A captura mostra a tela autenticada (ou a que deveria ser), entao fica fora
 * do versionamento -- `calibracao/ecac-*` esta no .gitignore.
 */
export async function registrarTela(pagina, documento) {
  try {
    const pasta = resolve(RAIZ, 'calibracao');
    await mkdir(pasta, { recursive: true });
    const base = resolve(pasta, `ecac-${String(documento).replace(/\D/g, '')}`);

    await pagina.screenshot({ path: `${base}.png`, fullPage: true });
    await writeFile(`${base}.html`, await pagina.content().catch(() => ''), 'utf8');
    return `calibracao/ecac-${String(documento).replace(/\D/g, '')}.png`;
  } catch {
    return null;
  }
}

/**
 * Ambiente de integracao continua (GitHub Actions e afins).
 *
 * O e-CAC roda com o certificado do cliente. Subir 20 A1 para um runner na
 * nuvem e risco desproporcional, e documentar "nao faca isso" nao impede que
 * aconteca -- por isso a recusa e do codigo, nao do README.
 */
export function emIntegracaoContinua(env = process.env) {
  return env.CI === 'true' || Boolean(env.GITHUB_ACTIONS);
}

export async function consultar({ cliente, idCertidao, config = {}, env = process.env }) {
  const receita = RECEITAS_ECAC[idCertidao];

  if (emIntegracaoContinua(env) && env.ECAC_PERMITIR_CI !== 'true') {
    return {
      situacao: 'manual',
      detalhe:
        'O e-CAC não roda em integração contínua: exige o certificado digital do cliente, que não deve ser enviado a um runner na nuvem. Rode na máquina do escritório.',
    };
  }
  if (!receita) {
    return {
      situacao: 'manual',
      detalhe: `O e-CAC não atende "${idCertidao}".`,
    };
  }

  const certificado = await resolverCertificado(cliente, config, env);
  if (certificado.erro) {
    return { situacao: 'manual', detalhe: certificado.erro };
  }

  const browser = await abrirNavegador(env);
  const contexto = await abrirContexto(browser, certificado);
  const pagina = await contexto.newPage();
  pagina.setDefaultTimeout(TEMPO_LIMITE);

  try {
    // O status da resposta separa "portal recusou" de "portal veio vazio".
    const resposta = await pagina.goto(LOGIN_ECAC, { waitUntil: 'domcontentloaded' });
    await pagina.waitForLoadState('networkidle').catch(() => {});
    const http = resposta?.status() ?? 0;

    const entrou = await entrar(pagina, (m) => console.error(m));
    if (!entrou) {
      const onde = await diagnosticar(pagina, 12);
      const captura = await registrarTela(pagina, cliente.documento);

      console.error(`      e-CAC: sessão não abriu. HTTP ${http} — ${onde.url}`);
      console.error(`      Título: "${onde.titulo}" · HTML com ${onde.tamanhoHtml} caracteres`);
      console.error(`      Texto: ${onde.texto.slice(0, 300) || '(a página está vazia)'}`);
      console.error(`      Links visíveis: ${onde.links.join(' | ') || '(nenhum)'}`);
      if (onde.quadros.length > 0) console.error(`      Quadros: ${onde.quadros.join(' | ')}`);
      if (captura) console.error(`      Tela salva em ${captura}`);
      // Tela sem texto nenhum e problema DIFERENTE de tela cheia com menu
      // trocado, e a correcao de uma nao serve para a outra. Separar os dois
      // aqui evita mandar o operador conferir procuracao quando o que houve
      // foi a conexao morrer no handshake.
      const vazia = onde.texto.length < 40;
      return {
        situacao: 'manual',
        detalhe: vazia
          ? `O portal do e-CAC respondeu HTTP ${http} e a página ficou em branco (${onde.tamanhoHtml} ` +
            'caracteres de HTML, nenhum texto). Isso é recusa do certificado no handshake ou bloqueio ' +
            `de rede — não menu mudado.${captura ? ` Tela em ${captura}.` : ''}`
          : 'A sessão do e-CAC não abriu com este certificado. Verifique validade, senha e ' +
            `se há procuração eletrônica para este cliente. A tela parou em "${onde.titulo || onde.url}".` +
            `${captura ? ` Tela em ${captura}.` : ''}`,
      };
    }

    const servico = await esperarSeletor(pagina, receita.caminhoServico, 20_000);
    if (!servico) {
      // O que existe na tela vale mais que o palpite do que deveria existir.
      const onde = await diagnosticar(pagina);
      console.error(`      e-CAC · ${receita.nome}: serviço não encontrado.`);
      console.error(`      Tela: ${onde.titulo} — ${onde.url}`);
      console.error(`      Links visíveis: ${onde.links.join(' | ') || '(nenhum)'}`);

      return {
        situacao: 'erro',
        detalhe:
          `Serviço "${receita.nome}" não encontrado nesta tela ("${onde.titulo || onde.url}"). ` +
          `O que há nela: ${onde.links.slice(0, 12).join(', ') || 'nenhum link'}.`,
      };
    }

    await pagina.click(servico);
    await pagina.waitForLoadState('networkidle').catch(() => {});

    const texto = await lerResultado(pagina, receita);
    if (!texto) {
      return {
        situacao: 'erro',
        detalhe: `A página do serviço não trouxe texto. Rode "npm run calibrar -- ${idCertidao}".`,
      };
    }

    return interpretar(texto, idCertidao);
  } catch (erro) {
    return { situacao: 'erro', detalhe: erro.message ?? String(erro) };
  } finally {
    await contexto.close().catch(() => {});
  }
}

async function lerResultado(pagina, receita) {
  await esperarSeletor(pagina, receita.sinaisResultado, 20_000);

  for (const seletor of receita.alvoResultado ?? []) {
    if ((await pagina.locator(seletor).count()) === 0) continue;

    const texto = ((await pagina.locator(seletor).first().textContent().catch(() => '')) ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!texto) continue;
    if ((receita.ruidos ?? []).some((padrao) => padrao.test(texto))) continue;

    return texto;
  }
  return '';
}

/**
 * O CADIN nao devolve "certidao": devolve se ha ou nao registro. "Nada consta"
 * e boa noticia; qualquer ocorrencia listada e pendencia.
 */
export function interpretar(texto, idCertidao) {
  const limpo = texto.slice(0, 400);

  if (idCertidao === 'cadin_federal') {
    const semRegistro = /nao (existem|ha) (registros|ocorrencias|pendencias)|nada consta/i.test(
      texto.normalize('NFD').replace(/\p{Diacritic}/gu, ''),
    );
    if (semRegistro) return { situacao: 'sem_registro', detalhe: limpo };

    const comRegistro = /registro|ocorrencia|pendencia|inscri/i.test(
      texto.normalize('NFD').replace(/\p{Diacritic}/gu, ''),
    );
    if (comRegistro) return { situacao: 'positiva', detalhe: limpo };

    return { situacao: 'erro', detalhe: `Resposta não reconhecida: "${limpo.slice(0, 180)}"` };
  }

  const situacao = interpretarTexto(texto);
  return situacao
    ? { situacao, detalhe: limpo }
    : { situacao: 'erro', detalhe: `Resposta não reconhecida: "${limpo.slice(0, 180)}"` };
}

export { primeiroSeletorPresente };
