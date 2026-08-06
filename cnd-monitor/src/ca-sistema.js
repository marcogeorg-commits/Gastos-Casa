/**
 * Confiar nas autoridades certificadoras que a máquina já confia.
 *
 * O Node não olha o chaveiro do sistema: ele embarca a lista da Mozilla e usa
 * só ela. Os portais da Receita são servidos por cadeias da ICP-Brasil, que
 * não estão naquela lista mas costumam estar no chaveiro de quem já usa
 * certificado digital.
 *
 * Sem isto a conexão morre antes de começar, e morre de um jeito que engana: o
 * Playwright devolve uma página de erro sua, com 193 caracteres e HTTP 503,
 * que parece portal fora do ar. Foi o que apareceu no e-CAC —
 * "unable to verify the first certificate" — depois de a rotina ter sido
 * acusada de estar com seletor errado, senha errada e falta de procuração.
 *
 * Equivale a rodar o Node com `--use-system-ca`, sem depender de o operador
 * lembrar do flag em toda chamada.
 *
 * O chaveiro do sistema nem sempre basta. O navegador, quando o servidor manda
 * a cadeia incompleta, sai buscando o certificado intermediário que falta; o
 * Node não faz isso. Por isso existe a pasta `ca/`: o que for posto lá passa a
 * valer junto. É a saída para "no navegador abre e aqui não".
 *
 * O efeito vale para o processo inteiro, e isso é deliberado: passamos a
 * confiar no que a máquina do escritório já confia. Não afrouxa a verificação:
 * continua exigindo cadeia válida, só aceita mais quem pode assiná-la.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PASTA_CA = resolve(RAIZ, 'ca');

const EXTENSOES = new Set(['.pem', '.crt', '.cer', '.ca-bundle']);

/**
 * Um arquivo pode trazer a cadeia inteira, um certificado por bloco.
 * Entregá-lo ao Node como um texto só faria valer apenas o primeiro.
 */
export function separarCertificados(texto) {
  return String(texto ?? '').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
}

export async function lerCasLocais(pasta = PASTA_CA) {
  let nomes;
  try {
    nomes = await readdir(pasta);
  } catch {
    return [];
  }

  const certificados = [];
  for (const nome of nomes.sort()) {
    if (!EXTENSOES.has(extname(nome).toLowerCase())) continue;
    const texto = await readFile(resolve(pasta, nome), 'utf8').catch(() => '');
    certificados.push(...separarCertificados(texto));
  }
  return certificados;
}

let resultado = null;

export async function confiarNasCasDoSistema(pasta = PASTA_CA) {
  if (resultado) return resultado;

  // As duas funções chegaram no Node 22.15. Em versão anterior o flag de linha
  // de comando ainda resolve, então a mensagem diz qual é a saída.
  if (typeof getCACertificates !== 'function' || typeof setDefaultCACertificates !== 'function') {
    resultado = {
      aplicado: false,
      locais: 0,
      motivo:
        `Este Node (${process.version}) não sabe ler as autoridades do sistema. ` +
        'Atualize para 22.15 ou mais novo, ou rode com NODE_OPTIONS=--use-system-ca.',
    };
    return resultado;
  }

  const locais = await lerCasLocais(pasta);

  try {
    // União, nunca substituição: tirar as embarcadas quebraria toda conexão
    // HTTPS comum do programa para consertar a do portal.
    setDefaultCACertificates([
      ...new Set([...getCACertificates('default'), ...getCACertificates('system'), ...locais]),
    ]);
    resultado = { aplicado: true, locais: locais.length };
  } catch (erro) {
    resultado = { aplicado: false, locais: locais.length, motivo: erro.message ?? String(erro) };
  }
  return resultado;
}

/**
 * A falha de cadeia se disfarça de portal fora do ar.
 *
 * Quem lê "HTTP 503" e "página vazia" conclui indisponibilidade e tenta de
 * novo amanhã. A mensagem do Playwright está no corpo — reconhecê-la evita
 * mandar o operador conferir validade de certificado, senha e procuração,
 * três coisas que não têm nada a ver com o problema.
 */
export function falhaDeCadeia(texto) {
  return /unable to verify the first certificate|client-certificate error|self.signed certificate|unable to get (local )?issuer/i.test(
    String(texto ?? ''),
  );
}
