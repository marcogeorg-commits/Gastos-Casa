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
import { stdin, stdout } from 'node:process';

export function perguntarSenha(rotulo = 'Senha do certificado: ') {
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
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let senha = '';

    const encerrar = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', aoDigitar);
      stdout.write('\n');
    };

    const aoDigitar = (tecla) => {
      if (tecla === '\r' || tecla === '\n') {
        encerrar();
        resolver(senha);
      } else if (tecla === '\u0003') {
        // Ctrl+C
        encerrar();
        rejeitar(new Error('Cancelado.'));
      } else if (tecla === '\u007f' || tecla === '\b') {
        senha = senha.slice(0, -1);
      } else {
        senha += tecla;
      }
    };

    stdin.on('data', aoDigitar);
  });
}
