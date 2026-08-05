import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Certificado digital A1 de cada cliente, para as consultas autenticadas no
 * e-CAC.
 *
 * Um `.pfx` mais a senha permitem assinar como o cliente. Por isso este módulo
 * é mais desconfiado que o resto do projeto: a senha nunca vem do arquivo de
 * cadastro, e o certificado é recusado se estiver dentro do repositório --
 * commitado uma vez, ele fica no histórico do Git para sempre, ao alcance de
 * quem tiver acesso hoje ou daqui a cinco anos.
 */

const RAIZ_PROJETO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Expande `~` para a pasta do usuário. */
export function expandirCaminho(caminho, casa = homedir()) {
  const texto = String(caminho ?? '');
  if (texto === '~') return casa;
  if (texto.startsWith(`~${sep}`) || texto.startsWith('~/')) {
    return resolve(casa, texto.slice(2));
  }
  return texto;
}

/**
 * O caminho está dentro do projeto (e portanto sob risco de virar commit)?
 *
 * Compara com separador no fim para não confundir `/repo-outro` com `/repo`.
 */
export function dentroDoProjeto(caminho, raiz = RAIZ_PROJETO) {
  const alvo = resolve(caminho);
  return alvo === raiz || alvo.startsWith(raiz + sep);
}

/**
 * Resolve o certificado de um cliente. Devolve `{ erro }` em vez de lançar:
 * um cadastro problemático vira aviso no relatório, não interrupção da rodada.
 */
export async function resolverCertificado(cliente, config = {}, env = process.env) {
  const declarado = cliente.certificado;
  if (!declarado) {
    return { erro: `${cliente.nome}: sem certificado digital no cadastro.` };
  }

  if (declarado.senha) {
    return {
      erro: `${cliente.nome}: a senha do certificado não pode ficar no cadastro. Use "senhaVariavel" e mantenha a senha numa variável de ambiente.`,
    };
  }

  const pasta = expandirCaminho(config.certificados?.pastaPadrao ?? '.');
  const bruto = expandirCaminho(declarado.arquivo ?? '');
  if (!bruto) return { erro: `${cliente.nome}: certificado sem "arquivo".` };

  const caminho = isAbsolute(bruto) ? bruto : resolve(pasta, bruto);

  if (dentroDoProjeto(caminho)) {
    return {
      erro: `${cliente.nome}: o certificado está dentro do projeto (${caminho}). Um .pfx commitado permanece no histórico do Git mesmo depois de apagado — guarde-o fora do repositório.`,
    };
  }

  try {
    await access(caminho);
    const info = await stat(caminho);
    if (!info.isFile()) return { erro: `${cliente.nome}: ${caminho} não é um arquivo.` };
  } catch {
    return { erro: `${cliente.nome}: certificado não encontrado em ${caminho}.` };
  }

  const variavel = declarado.senhaVariavel;
  if (!variavel) {
    return { erro: `${cliente.nome}: falta "senhaVariavel" apontando para a variável com a senha.` };
  }

  const senha = env[variavel];
  if (!senha) {
    return { erro: `${cliente.nome}: a variável ${variavel} não está definida no ambiente.` };
  }

  return { caminho, senha, variavel };
}
