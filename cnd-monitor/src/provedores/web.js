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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { salvarComprovante } from '../comprovante.js';
import { extrairTextoPdf } from '../pdf-texto.js';
import { interpretarTexto } from '../situacao.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECEITAS, extrairValidade } from '../receitas/index.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const id = 'web';
export const nome = 'Automação própria (Playwright)';

const TEMPO_LIMITE = 45_000;

export function suporta(idCertidao) {
  return Boolean(RECEITAS[idCertidao]);
}

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

const MARCAS_CAPTCHA = [
  'iframe[src*="hcaptcha"]',
  'iframe[src*="recaptcha"]',
  '.g-recaptcha',
  '[class*="hcaptcha"]',
  '[id*="captcha" i]',
  'input[name*="captcha" i]',
  'img[src*="captcha" i]',
];

// Abaixo disso o elemento nao e um desafio para o usuario clicar: e o iframe de
// servico do captcha invisivel, ou um campo escondido.
const LARGURA_MINIMA = 60;
const ALTURA_MINIMA = 30;

/**
 * Detecta captcha e diz se ele bloqueia a automacao.
 *
 * A distincao importa: o captcha **invisivel** (hCaptcha/reCAPTCHA v3) nao pede
 * nada ao usuario -- pontua o comportamento em segundo plano e so desafia sob
 * suspeita. Recusar a consulta so por ele existir descartaria um portal que
 * talvez responda normalmente. Ja o captcha visivel exige interacao humana e
 * nao ha o que tentar.
 *
 * A decisao vem da **geometria**, nao da URL. Ler `size=invisible` do src era
 * fragil: o portal da Receita monta varios iframes do hCaptcha, e bastava o
 * primeiro da lista nao trazer a marca -- ou um campo oculto casar antes -- para
 * o hCaptcha invisivel ser classificado como visivel e a consulta ser recusada
 * sem nem tentar. Um desafio que exige clique ocupa espaco na tela; medir isso
 * responde exatamente a pergunta que importa.
 */
/**
 * Campos onde o humano digita a resposta de um desafio.
 *
 * Existir um campo desses visivel prova mais do que a geometria do widget: e a
 * confissao do portal de que espera alguem lendo ou ouvindo alguma coisa.
 */
const MARCAS_RESPOSTA = [
  'input[id*="resposta" i][type="text"]',
  'input[name*="resposta" i][type="text"]',
  'input[id*="captcha" i][type="text"]',
  'input[name*="captcha" i][type="text"]',
];

/**
 * Ha um campo de resposta de captcha esperando digitacao?
 *
 * O widget do desafio pode ser desenhado de mil formas -- canvas, imagem em
 * base64, audio -- e nem sempre casa com os seletores conhecidos. O campo onde
 * a resposta e digitada, nao: ele e sempre um input de texto visivel.
 */
async function campoDeRespostaVisivel(pagina) {
  for (const seletor of MARCAS_RESPOSTA) {
    const alvo = await primeiroVisivel(pagina, [seletor]);
    if (alvo) return seletor;
  }
  return null;
}

export async function detectarCaptcha(pagina) {
  let achado = null;

  // Antes da geometria: um campo de resposta visivel decide sozinho. Foi o que
  // faltou no CNDT -- o reCAPTCHA la e invisivel de verdade, mas ao lado dele
  // ha um desafio proprio com campo de resposta e botao "Ouvir". Medindo so o
  // widget, o portal foi declarado automatizavel quando nao e.
  const resposta = await campoDeRespostaVisivel(pagina);
  if (resposta) {
    return {
      seletor: resposta,
      provedor: 'desafio próprio do portal',
      invisivel: false,
      bloqueante: true,
    };
  }

  for (const seletor of MARCAS_CAPTCHA) {
    const alvos = pagina.locator(seletor);
    const quantos = await alvos.count();
    if (quantos === 0) continue;

    for (let i = 0; i < Math.min(quantos, 6); i += 1) {
      const alvo = alvos.nth(i);
      const src = (await alvo.getAttribute('src').catch(() => null)) ?? '';
      const provedor =
        /hcaptcha/i.test(src) || /hcaptcha/i.test(seletor) ? 'hCaptcha' : 'reCAPTCHA';

      achado ??= { seletor, provedor, invisivel: true, bloqueante: false };

      if (!(await alvo.isVisible().catch(() => false))) continue;
      const caixa = await alvo.boundingBox().catch(() => null);
      if (!caixa || caixa.width < LARGURA_MINIMA || caixa.height < ALTURA_MINIMA) continue;

      // Um desafio de tamanho real na tela: nao ha o que automatizar.
      return { seletor, provedor, invisivel: false, bloqueante: true };
    }
  }

  return achado;
}

/** Tenta cada seletor candidato e devolve o primeiro presente na pagina. */
export async function primeiroSeletorPresente(pagina, candidatos) {
  for (const seletor of candidatos ?? []) {
    if ((await pagina.locator(seletor).count()) > 0) return seletor;
  }
  return null;
}

/**
 * Primeiro elemento **visivel** entre os candidatos. Devolve o locator, nao o
 * seletor.
 *
 * `primeiroSeletorPresente` conta elementos ocultos, e componentes de aviso
 * costumam existir no DOM o tempo todo, escondidos. Para decidir "tem um
 * dialogo na frente do usuario?" so serve o que esta de fato visivel.
 *
 * Varre todos os elementos de cada seletor, e nao so o primeiro: um mesmo texto
 * de botao aparece no painel escondido e na barra visivel, e olhar so o
 * primeiro faria desistir do que estava a vista. Devolver o locator preserva
 * qual deles: reconstruir pelo seletor traria de volta o oculto.
 */
export async function primeiroVisivel(pagina, candidatos) {
  for (const seletor of candidatos ?? []) {
    const alvos = pagina.locator(seletor);
    const quantos = await alvos.count();

    for (let i = 0; i < Math.min(quantos, 10); i += 1) {
      const alvo = alvos.nth(i);
      if (await alvo.isVisible().catch(() => false)) return alvo;
    }
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

  // Prioridade antes de pressa: se algum candidato ja esta na pagina, vale o de
  // maior prioridade. A corrida abaixo devolve quem resolver primeiro, e um
  // seletor generico como `body` sempre venceria o especifico.
  const jaPresente = await primeiroSeletorPresente(pagina, lista);
  if (jaPresente) return jaPresente;

  try {
    // Nenhum na tela ainda: vale o primeiro que a pagina renderizar.
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

/**
 * Guarda a tela e o texto da pagina quando a consulta falha.
 *
 * Sem isso, diagnosticar exige reproduzir o erro -- e portais publicos mudam
 * entre uma tentativa e outra. A captura e o que a proxima rodada de ajuste
 * tem de concreto.
 */
async function registrarFalha(pagina, idCertidao, cliente) {
  try {
    const pasta = resolve(RAIZ, 'calibracao');
    await mkdir(pasta, { recursive: true });
    const base = resolve(pasta, `falha-${idCertidao}-${cliente.documento}`);

    await pagina.screenshot({ path: `${base}.png`, fullPage: true });
    const texto = await pagina.textContent('body').catch(() => '');
    await writeFile(
      `${base}.txt`,
      `URL: ${pagina.url()}\n\n${String(texto ?? '').replace(/\s+/g, ' ').trim()}\n`,
      'utf8',
    );
    return `calibracao/falha-${idCertidao}-${cliente.documento}.png`;
  } catch {
    return null;
  }
}

export async function consultar({ cliente, idCertidao, env = process.env, competencia = 'avulso' }) {
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
  // `acceptDownloads` precisa estar ligado antes de qualquer navegacao: o CNDT
  // entrega a certidao como download, e sem isso ela e descartada.
  const contexto = await browser.newContext({
    acceptDownloads: true,
    locale: 'pt-BR',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  });
  const pagina = await contexto.newPage();
  pagina.setDefaultTimeout(TEMPO_LIMITE);

  // O download pode acontecer a qualquer momento do fluxo; guardar o ultimo
  // evita ter de adivinhar em qual clique ele vem.
  let baixado = null;
  pagina.on('download', (d) => {
    baixado = d;
  });

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
      if (captcha?.bloqueante) {
        return {
          situacao: 'manual',
          detalhe: `${receita.nome} protegido por ${captcha.provedor} visível — exige interação humana.`,
        };
      }

      if (!temFormulario) {
        tentativas.push(`${url}: abriu, mas o campo do documento não apareceu`);
        continue;
      }

      const resultado = await receita.executar({
        pagina,
        cliente,
        primeiroSeletorPresente,
        primeiroVisivel,
        esperarSeletor,
        env,
        // Progresso vai para stderr: a saída normal é o resultado da consulta.
        registrar: (mensagem) => console.error(mensagem),
      });

      // Captcha invisivel nao impede a tentativa, mas explica um fracasso: sem
      // essa nota, uma consulta barrada pareceria um portal fora do ar.
      if (captcha && resultado.situacao === 'erro') {
        resultado.detalhe = `${resultado.detalhe} (a página usa ${captcha.provedor} invisível — pode ter barrado a automação)`;
      }
      // O comprovante e guardado SEMPRE que houve download, inclusive quando a
      // leitura da pagina falhou. Antes, "nao trouxe texto de resultado"
      // descartava junto a certidao que o portal ja tinha entregue -- o
      // programa tinha o documento nas maos e jogava fora.
      if (baixado || resultado.situacao !== 'erro') {
        resultado.arquivo = await salvarComprovante({
          pagina,
          download: baixado,
          raiz: RAIZ,
          competencia,
          cliente,
          idCertidao,
        });
      }

      // A certidao e a fonte, nao a tela. A pagina do portal diz so "emitida
      // com sucesso" -- a mesma frase para negativa e para positiva com efeito
      // de negativa, que sao coisas diferentes para quem presta contas.
      const doPdf = await lerDoComprovante(resultado.arquivo);
      if (doPdf) {
        const arquivo = resultado.arquivo;
        resultado = { ...doPdf, arquivo };
      }

      if (resultado.situacao === 'erro') {
        const captura = await registrarFalha(pagina, idCertidao, cliente);
        if (captura) resultado.detalhe = `${resultado.detalhe} — tela salva em ${captura}`;
      }
      return resultado;
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

/**
 * O que a certidao diz, lida de dentro do arquivo.
 *
 * Vale mais que o texto da tela: a tela do portal da Receita anuncia "emitida
 * com sucesso" tanto para negativa quanto para positiva com efeito de
 * negativa. So o documento distingue.
 *
 * Devolve `null` quando nao ha arquivo, quando nao e PDF, ou quando o texto
 * nao foi reconhecido -- e ai vale o que a pagina disse. Nunca chuta: certidao
 * mal lida vira um "negativa" que ninguem conferiu.
 */
export async function lerDoComprovante(caminho, ler = readFile) {
  if (!caminho || !/\.pdf$/i.test(caminho)) return null;

  const texto = await ler(caminho).then(extrairTextoPdf).catch(() => null);
  if (!texto) return null;

  const situacao = interpretarTexto(texto);
  if (!situacao) return null;

  return {
    situacao,
    detalhe: texto.slice(0, 400),
    validaAte: extrairValidade(texto),
  };
}
