/**
 * Provedor assistido — a maquina faz tudo, menos o captcha.
 *
 * Os portais publicos de certidao protegem a emissao com captcha, e isso e
 * deliberado: o orgao quer uma pessoa ali. Este provedor respeita exatamente
 * isso e nada alem disso. Ele abre o portal, atravessa as telas intermediarias,
 * digita o documento e le o desfecho; o unico passo que fica para o operador e
 * o captcha, que e o passo que o orgao reservou para um humano.
 *
 * Nao ha disfarce, resolvedor automatico nem tentativa de parecer outra coisa.
 * O ganho e de digitacao, nao de permissao: para vinte clientes, troca "abrir
 * vinte abas, digitar vinte CNPJs, copiar vinte respostas" por "resolver vinte
 * captchas", com o resultado ja lido e gravado no relatorio.
 *
 * Exige janela visivel e alguem na frente dela. Por isso recusa rodar sem
 * interface -- uma rodada agendada de madrugada ficaria parada cinco minutos
 * por consulta esperando um clique que nunca vem.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECEITAS } from '../receitas/index.js';
import { salvarComprovante } from '../comprovante.js';
import { detectarCaptcha, esperarSeletor, primeiroSeletorPresente, primeiroVisivel } from './web.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const id = 'assistido';
export const nome = 'Assistido (você resolve só o captcha)';

const TEMPO_LIMITE = 60_000;
const ESPERA_HUMANO = 600_000;

export function suporta(idCertidao) {
  return Boolean(RECEITAS[idCertidao]);
}

export function credenciaisFaltando() {
  return []; // A credencial e a pessoa na frente da tela.
}

let navegador = null;

/**
 * Fila de uma consulta por vez.
 *
 * A concorrencia da rodada ja e forcada a 1 no chamador, mas isso e uma
 * combinacao entre modulos -- e a combinacao foi quebrada uma vez, com o
 * operador vendo sete janelas abrirem em cima uma da outra. Aqui a garantia e
 * estrutural: enquanto uma consulta assistida nao termina, a proxima nem
 * comeca, venha ela de onde vier.
 */
let fila = Promise.resolve();

function enfileirar(tarefa) {
  const minhaVez = fila.then(tarefa, tarefa);
  // A fila nao pode morrer por causa de uma consulta que falhou.
  fila = minhaVez.then(
    () => {},
    () => {},
  );
  return minhaVez;
}

async function abrirNavegador(env) {
  if (navegador) return navegador;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'O modo assistido exige o Playwright. Rode: npm run preparar-web',
    );
  }

  // Sempre com janela: o modo inteiro depende de alguem enxergar o captcha.
  navegador = await chromium.launch({
    headless: false,
    ...(env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    args: ['--no-sandbox'],
  });
  return navegador;
}

export async function encerrar() {
  if (!navegador) return;
  await navegador.close().catch(() => {});
  navegador = null;
}

/**
 * Ha alguem para resolver o captcha?
 *
 * Sem interface grafica a janela nem abre. Recusar aqui, com o motivo, e melhor
 * que estourar dentro do Playwright com "missing X server".
 */
export function temOperador(env = process.env) {
  if (env.CI === 'true' || env.GITHUB_ACTIONS) return false;
  if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

export async function consultar(argumentos) {
  // Uma janela de cada vez, sempre.
  return enfileirar(() => consultarAgora(argumentos));
}

async function consultarAgora({ cliente, idCertidao, env = process.env, competencia = 'avulso' }) {
  const receita = RECEITAS[idCertidao];

  if (!receita) {
    return {
      situacao: 'manual',
      detalhe: `Sem receita de automação para "${idCertidao}".`,
    };
  }
  if (!temOperador(env)) {
    return {
      situacao: 'manual',
      detalhe:
        'O modo assistido precisa de uma janela de navegador e de alguém para resolver o captcha. Rode na máquina do escritório.',
    };
  }

  const impedimento = receita.impedimento?.(cliente);
  if (impedimento) return { situacao: 'manual', detalhe: impedimento };

  const browser = await abrirNavegador(env);
  // Um contexto por consulta: sessão de um cliente não pode vazar para a do
  // seguinte, e portal de certidão guarda estado entre emissões.
  const contexto = await browser.newContext({ acceptDownloads: true, locale: 'pt-BR' });
  const pagina = await contexto.newPage();
  pagina.setDefaultTimeout(TEMPO_LIMITE);

  let baixado = null;
  pagina.on('download', (d) => {
    baixado = d;
  });

  try {
    const urls = receita.urlsPara?.(cliente) ?? receita.urls ?? [receita.url];
    let abriu = false;

    for (const url of urls) {
      try {
        await pagina.goto(url, { waitUntil: 'domcontentloaded' });
        abriu = true;
        break;
      } catch {
        // Proxima URL da receita.
      }
    }

    if (!abriu) {
      return { situacao: 'erro', detalhe: `Nenhuma URL de ${receita.nome} abriu desta máquina.` };
    }

    await pagina.bringToFront().catch(() => {});

    // Diferente do provedor automatico, aqui captcha nao e motivo de recusa: e
    // exatamente o que o operador veio fazer. Detectar serve para avisar.
    const captcha = await detectarCaptcha(pagina);

    const resultado = await receita.executarAssistido({
      pagina,
      cliente,
      primeiroSeletorPresente,
      primeiroVisivel,
      esperarSeletor,
      env,
      esperaHumano: Number(env.ESPERA_HUMANO ?? ESPERA_HUMANO),
      registrar: (mensagem) => console.error(mensagem),
    });

    if (captcha?.bloqueante && resultado.situacao === 'erro') {
      resultado.detalhe = `${resultado.detalhe} (o portal usa ${captcha.provedor})`;
    }

    if (resultado.situacao !== 'erro') {
      resultado.arquivo = await salvarComprovante({
        pagina,
        download: baixado,
        raiz: RAIZ,
        competencia,
        cliente,
        idCertidao,
      });
    }
    return resultado;
  } catch (erro) {
    return { situacao: 'erro', detalhe: `${receita.nome}: ${erro.message}` };
  } finally {
    await contexto.close().catch(() => {});
  }
}
