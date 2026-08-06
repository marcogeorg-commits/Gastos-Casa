/**
 * Confiar nas autoridades certificadoras que a máquina já confia.
 *
 * O Node não olha o chaveiro do sistema: ele embarca a lista da Mozilla e usa
 * só ela. Os portais da Receita são servidos por cadeias da ICP-Brasil, que
 * não estão naquela lista — mas estão no chaveiro de qualquer máquina que já
 * usa certificado digital, porque instalar a cadeia é parte de instalar o
 * certificado.
 *
 * Sem isto a conexão morre antes de começar. E morre de um jeito que engana:
 * o Playwright devolve uma página de erro sua, com 193 caracteres e HTTP 503,
 * que parece portal fora do ar. Foi o que apareceu no e-CAC —
 * "unable to verify the first certificate" — depois de a rotina ter sido
 * acusada de estar com seletor errado, senha errada e falta de procuração.
 *
 * Equivale a rodar o Node com `--use-system-ca`, sem depender de o operador
 * lembrar do flag em toda chamada.
 *
 * O efeito vale para o processo inteiro, e isso é deliberado: passamos a
 * confiar no que a máquina do escritório já confia — o mesmo conjunto que o
 * navegador dela usa. Não afrouxa a verificação: continua exigindo cadeia
 * válida, só aceita mais quem pode assiná-la.
 */

import { getCACertificates, setDefaultCACertificates } from 'node:tls';

let resultado = null;

export function confiarNasCasDoSistema() {
  if (resultado) return resultado;

  // As duas funções chegaram no Node 22.15. Em versão anterior o flag de linha
  // de comando ainda resolve, então a mensagem diz qual é a saída.
  if (typeof getCACertificates !== 'function' || typeof setDefaultCACertificates !== 'function') {
    resultado = {
      aplicado: false,
      motivo:
        `Este Node (${process.version}) não sabe ler as autoridades do sistema. ` +
        'Atualize para 22.15 ou mais novo, ou rode com NODE_OPTIONS=--use-system-ca.',
    };
    return resultado;
  }

  try {
    // União: as do sistema entram sem tirar nenhuma das que já valiam. Tirar
    // seria trocar um problema por outro -- quebraria toda conexão HTTPS comum
    // do programa para consertar a do portal.
    setDefaultCACertificates([
      ...new Set([...getCACertificates('default'), ...getCACertificates('system')]),
    ]);
    resultado = { aplicado: true };
  } catch (erro) {
    resultado = { aplicado: false, motivo: erro.message ?? String(erro) };
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
  return /unable to verify the first certificate|client-certificate error|self.signed certificate/i.test(
    String(texto ?? ''),
  );
}
