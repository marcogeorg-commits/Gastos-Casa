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

import { resolverCertificado } from '../certificados.js';
import { interpretarTexto } from '../situacao.js';
import { LOGIN_ECAC, ORIGENS_CERTIFICADO, RECEITAS_ECAC } from '../receitas/ecac.js';
import { esperarSeletor, primeiroSeletorPresente, primeiroVisivel } from './web.js';

export const id = 'ecac';
export const nome = 'e-CAC (certificado digital)';

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
 * Entrou de fato?
 *
 * Sem essa checagem, uma sessão recusada seguiria para a tela de serviço e a
 * leitura devolveria o texto da página de login como se fosse resultado.
 */
export async function autenticado(pagina) {
  const marcasDeLogin = [
    'text=/certificado digital/i',
    'text=/entrar com gov.br/i',
    'input[type="password"]',
  ];
  return (await primeiroVisivel(pagina, marcasDeLogin)) === null;
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
    await pagina.goto(LOGIN_ECAC, { waitUntil: 'domcontentloaded' });
    await pagina.waitForLoadState('networkidle').catch(() => {});

    if (!(await autenticado(pagina))) {
      return {
        situacao: 'manual',
        detalhe:
          'O e-CAC não aceitou o certificado — verifique validade, senha e se há procuração eletrônica para este cliente.',
      };
    }

    const servico = await esperarSeletor(pagina, receita.caminhoServico, 20_000);
    if (!servico) {
      return {
        situacao: 'erro',
        detalhe: `Serviço "${receita.nome}" não encontrado no menu. Rode "npm run calibrar -- ${idCertidao}".`,
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
