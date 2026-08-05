/**
 * Provedor "web" -- automacao propria com Playwright, sem custo por consulta.
 *
 * Limitacao honesta: portais que exigem captcha nao sao automatizaveis por aqui,
 * e o captcha esta la justamente para isso. Quando a receita detecta um, a
 * consulta volta como `manual` com o motivo -- nunca como um resultado
 * inventado. Resolver captcha e exatamente o que se paga ao contratar um
 * provedor de automacao.
 *
 * Os seletores de cada portal ficam em `src/receitas/`. Rode
 * `npm run calibrar -- <certidao>` a partir de uma maquina com acesso aos
 * portais para conferir/atualizar os seletores de uma vez.
 */

import { RECEITAS } from '../receitas/index.js';

export const id = 'web';
export const nome = 'Automação própria (Playwright)';

const TEMPO_LIMITE = 45_000;

export function credenciaisFaltando() {
  return []; // Consulta publica: nao ha credencial a exigir.
}

let navegador = null;

async function abrirNavegador(env) {
  if (navegador) return navegador;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'O provedor "web" exige o Playwright. Rode: npm install playwright && npx playwright install chromium',
    );
  }

  navegador = await chromium.launch({
    headless: env.WEB_HEADLESS !== 'false',
    // Em ambientes que ja trazem o Chromium (CI, container), aponte para ele.
    ...(env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox'],
  });
  return navegador;
}

/** Fecha o navegador compartilhado ao fim da rodada. */
export async function encerrar() {
  if (!navegador) return;
  await navegador.close().catch(() => {});
  navegador = null;
}

/**
 * Um captcha na pagina invalida a automacao. Detectado antes de qualquer
 * tentativa de leitura, para nao interpretar a pagina do desafio como resposta.
 */
export async function detectarCaptcha(pagina) {
  const marcas = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    '.g-recaptcha',
    '[class*="hcaptcha"]',
    '[id*="captcha" i]',
    'input[name*="captcha" i]',
    'img[src*="captcha" i]',
  ];

  for (const marca of marcas) {
    if ((await pagina.locator(marca).count()) > 0) return marca;
  }
  return null;
}

/** Tenta cada seletor candidato e devolve o primeiro presente na pagina. */
export async function primeiroSeletorPresente(pagina, candidatos) {
  for (const seletor of candidatos ?? []) {
    if ((await pagina.locator(seletor).count()) > 0) return seletor;
  }
  return null;
}

/**
 * Versao que espera o elemento aparecer, em vez de olhar uma vez so.
 *
 * O portal da Receita e um SPA com rotas em hash: quando o `goto` retorna, o
 * HTML esta em pe mas o formulario ainda nao foi renderizado. Sondar na hora
 * daria "campo nao encontrado" mesmo com a URL correta.
 */
export async function esperarSeletor(pagina, candidatos, tempoLimite = 20_000) {
  const lista = candidatos ?? [];
  if (lista.length === 0) return null;

  try {
    // Corrida entre os candidatos: vale o primeiro que a pagina renderizar.
    return await Promise.any(
      lista.map((seletor) =>
        pagina
          .locator(seletor)
          .first()
          .waitFor({ state: 'attached', timeout: tempoLimite })
          .then(() => seletor),
      ),
    );
  } catch {
    return null;
  }
}

export async function consultar({ cliente, idCertidao, env = process.env }) {
  const receita = RECEITAS[idCertidao];

  if (!receita) {
    return {
      situacao: 'manual',
      detalhe: `Sem receita de automação para "${idCertidao}". Use um provedor de API ou consulte no portal.`,
    };
  }

  const impedimento = receita.impedimento?.(cliente);
  if (impedimento) {
    return { situacao: 'manual', detalhe: impedimento };
  }

  const browser = await abrirNavegador(env);
  const contexto = await browser.newContext({
    locale: 'pt-BR',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  });
  const pagina = await contexto.newPage();
  pagina.setDefaultTimeout(TEMPO_LIMITE);

  try {
    // Portais publicos trocam de endereco sem aviso (e sem redirecionar), entao
    // a receita pode listar varias URLs. Vale a primeira que abrir com o
    // formulario esperado.
    const urls = receita.urlsPara?.(cliente) ?? receita.urls ?? [receita.url];
    const tentativas = [];

    for (const url of urls) {
      try {
        await pagina.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (erro) {
        tentativas.push(`${url}: ${erro.message.split('\n')[0]}`);
        continue;
      }

      // O formulario pode demorar a existir; so depois disso faz sentido
      // procurar captcha, que tambem e renderizado pelo app.
      const temFormulario = await esperarSeletor(pagina, receita.seletores.campoDocumento);

      const captcha = await detectarCaptcha(pagina);
      if (captcha) {
        return {
          situacao: 'manual',
          detalhe: `${receita.nome} protegido por captcha (${captcha}) — não automatizável sem um provedor pago.`,
        };
      }

      if (!temFormulario) {
        tentativas.push(`${url}: abriu, mas o campo do documento não apareceu`);
        continue;
      }

      return await receita.executar({
        pagina,
        cliente,
        primeiroSeletorPresente,
        esperarSeletor,
      });
    }

    return {
      situacao: 'erro',
      detalhe: `Nenhuma URL apresentou o formulário esperado — ${tentativas.join('; ')}. Rode "npm run calibrar -- ${receita.id}".`,
    };
  } catch (erro) {
    return { situacao: 'erro', detalhe: `${receita.nome}: ${erro.message}` };
  } finally {
    await contexto.close().catch(() => {});
  }
}
