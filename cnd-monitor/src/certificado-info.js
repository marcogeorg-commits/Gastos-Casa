/**
 * Quem e o dono deste certificado, lido de dentro do arquivo.
 *
 * O padrao ICP-Brasil poe nome e documento no campo CN do titular, na forma
 * "RAZAO SOCIAL LTDA:12345678000199" para e-CNPJ e "FULANO DE TAL:12345678901"
 * para e-CPF. Com a senha, isso e informacao de primeira mao -- muito melhor
 * que adivinhar pelo nome do arquivo, que so acerta quando a certificadora
 * resolveu colocar o CNPJ ali.
 *
 * Le pelo `openssl`, que existe em qualquer macOS e Linux. O Node nao abre
 * PKCS#12 pela biblioteca padrao, e trazer uma dependencia de criptografia so
 * para ler um campo de texto seria caro demais para o que se ganha.
 *
 * A senha nunca vai na linha de comando: argumento de processo aparece em `ps`
 * para qualquer usuario da maquina. Vai por um descritor de arquivo proprio.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { limpar, tipoDocumento, validar } from './documentos.js';

const executar = promisify(execFile);

/** Extrai "NOME:DOCUMENTO" do CN, no padrao ICP-Brasil. */
export function interpretarSujeito(subject) {
  const cn = String(subject ?? '').match(/CN\s*=\s*([^,/\n]+)/i)?.[1]?.trim();
  if (!cn) return { nome: null, documento: null };

  // O documento vem depois do ultimo ":" -- razao social pode conter ":".
  const corte = cn.lastIndexOf(':');
  if (corte < 0) return { nome: cn, documento: null };

  const documento = limpar(cn.slice(corte + 1));
  const nome = cn.slice(0, corte).trim();

  return {
    nome: nome || null,
    documento: validar(documento) ? documento : null,
  };
}

/** "Aug  6 19:14:22 2027 GMT" vira "2027-08-06". */
export function interpretarValidade(notAfter) {
  const data = new Date(String(notAfter ?? '').replace(/^notAfter=/, ''));
  return Number.isNaN(data.getTime()) ? null : data.toISOString().slice(0, 10);
}

/**
 * Identidade do certificado. Devolve `{ erro }` em vez de lancar: um arquivo
 * com senha errada nao pode interromper a leitura dos outros vinte e dois.
 */
export async function lerCertificado(caminho, senha) {
  const tentar = (legado) =>
    new Promise((resolver, rejeitar) => {
      const args = ['pkcs12', '-in', caminho, '-nokeys', '-clcerts', '-passin', 'fd:3'];
      if (legado) args.push('-legacy');

      // O quarto item do stdio cria o descritor 3. A senha vai por ele; como
      // argumento, apareceria em `ps` para qualquer usuario da maquina.
      const proc = spawn('openssl', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });

      let saida = '';
      let erro = '';
      proc.stdout.on('data', (p) => (saida += p));
      proc.stderr.on('data', (p) => (erro += p));
      proc.on('error', rejeitar);
      proc.on('close', (codigo) =>
        codigo === 0 ? resolver(saida) : rejeitar(new Error(erro || `openssl saiu com ${codigo}`)),
      );

      proc.stdio[3].on('error', () => {});
      proc.stdio[3].end(`${senha}\n`);
    });

  const detalhes = (pem) =>
    new Promise((resolver, rejeitar) => {
      const proc = spawn('openssl', ['x509', '-noout', '-subject', '-enddate']);
      let saida = '';
      proc.stdout.on('data', (p) => (saida += p));
      proc.on('error', rejeitar);
      proc.on('close', () => resolver(saida));
      proc.stdin.end(pem);
    });

  let pem;
  let primeiroErro;
  try {
    pem = await tentar(false);
  } catch (e) {
    primeiroErro = e;
    // Certificados antigos usam RC2, que o OpenSSL 3 so abre em modo legado.
    try {
      pem = await tentar(true);
    } catch {
      const texto = String(primeiroErro?.message ?? '');
      if (/ENOENT/.test(texto)) {
        return { erro: 'o openssl não está disponível nesta máquina' };
      }
      return {
        erro: /mac verify failure|invalid password|wrong password|verify error/i.test(texto)
          ? 'senha incorreta'
          : 'não foi possível abrir o arquivo',
      };
    }
  }

  const saida = await detalhes(pem);
  const { nome, documento } = interpretarSujeito(saida.match(/^subject=(.*)$/m)?.[1] ?? '');

  if (!documento) {
    return { erro: 'o certificado abriu, mas não traz CNPJ nem CPF no titular' };
  }

  return {
    nome,
    documento,
    tipo: tipoDocumento(documento),
    validoAte: interpretarValidade(saida.match(/^notAfter=(.*)$/m)?.[1] ?? ''),
  };
}

/** Verifica se o `openssl` esta disponivel nesta maquina. */
export async function temOpenssl() {
  try {
    await executar('openssl', ['version']);
    return true;
  } catch {
    return false;
  }
}
