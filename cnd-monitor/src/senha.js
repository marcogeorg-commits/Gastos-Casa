/**
 * Senha digitada no terminal, sem eco.
 *
 * A calibracao e feita por um humano sentado na frente da maquina. Exigir que
 * ele configure o `.env` antes de descobrir se o certificado sequer entra no
 * portal e inverter a ordem: primeiro se testa, depois se automatiza.
 *
 * O valor fica so na memoria deste processo. Nao vai para o historico do shell
 * -- que e onde ele acabaria se a alternativa fosse `SENHA=... npm run ...`.
 */
import { stdin as entradaPadrao, stdout as saidaPadrao } from 'node:process';

export function perguntarSenha(rotulo = 'Senha do certificado: ', stdin = entradaPadrao, stdout = saidaPadrao) {
  return new Promise((resolver, rejeitar) => {
    if (!stdin.isTTY) {
      rejeitar(
        new Error(
          'Sem terminal interativo para pedir a senha. Defina a variável no .env e informe --senha-variavel.',
        ),
      );
      return;
    }

    stdout.write(rotulo);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let senha = '';

    const encerrar = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', aoDigitar);
      stdout.write('\n');
    };

    /**
     * Um bloco pode trazer varias teclas.
     *
     * Em modo bruto o terminal costuma entregar uma tecla por vez, mas nao e
     * garantia: colar a senha, ou digitar depressa, chega como um bloco so.
     * Tratar o bloco como uma tecla fazia o Enter no fim dele nao ser
     * reconhecido -- e o prompt ficava esperando para sempre, com a senha
     * inteira ja digitada.
     */
    const aoDigitar = (bloco) => {
      for (const tecla of String(bloco)) {
        if (tecla === '\r' || tecla === '\n') {
          encerrar();
          resolver(senha);
          return;
        }
        if (tecla === '\u0003') {
          // Ctrl+C
          encerrar();
          rejeitar(new Error('Cancelado.'));
          return;
        }
        if (tecla === '\u007f' || tecla === '\b') {
          senha = senha.slice(0, -1);
        } else {
          senha += tecla;
        }
      }
    };

    stdin.on('data', aoDigitar);
  });
}

/**
 * Pergunta com eco: para o que nao e segredo, como escolher um item da lista.
 *
 * Esconder a digitacao aqui so atrapalharia -- o operador precisa ver o numero
 * que escolheu.
 */
export function perguntarTexto(rotulo, stdin = entradaPadrao, stdout = saidaPadrao) {
  return new Promise((resolver, rejeitar) => {
    if (!stdin.isTTY) {
      rejeitar(new Error('Sem terminal interativo.'));
      return;
    }

    stdout.write(rotulo);
    stdin.resume();
    stdin.setEncoding('utf8');

    const aoDigitar = (dado) => {
      stdin.pause();
      stdin.removeListener('data', aoDigitar);
      resolver(String(dado).trim());
    };
    stdin.on('data', aoDigitar);
  });
}
