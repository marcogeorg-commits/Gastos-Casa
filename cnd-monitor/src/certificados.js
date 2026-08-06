import { access, readdir, stat } from 'node:fs/promises';
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
 * Acha, na lista de arquivos, o certificado que pertence a este documento.
 *
 * Certificado A1 emitido no Brasil quase sempre traz o CNPJ no nome do arquivo
 * -- "EMPRESA LTDA 12345678000199.pfx" e a forma mais comum. Ler o documento de
 * dentro do `.pfx` seria mais confiavel, mas o arquivo e cifrado: exigiria a
 * senha so para descobrir de quem ele e, e a senha e justamente o que o
 * operador ainda nao configurou nesse momento.
 *
 * Casa tambem quando o nome tem pontuacao ("12.345.678/0001-99"), porque so os
 * digitos sao comparados. Devolve null quando ha duvida -- dois arquivos com o
 * mesmo documento e caso para o humano escolher, nao para o programa chutar.
 */
export function casarPorDocumento(arquivos, documento) {
  const alvo = String(documento ?? '').replace(/\D/g, '');
  if (alvo.length !== 14 && alvo.length !== 11) return null;

  const candidatos = arquivos.filter((nome) => nome.replace(/\D/g, '').includes(alvo));
  return candidatos.length === 1 ? candidatos[0] : null;
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

  // Caminho relativo (`../Certificados`) se resolve a partir da pasta do
  // projeto, nao do diretorio de onde o comando foi chamado: senao a mesma
  // configuracao acharia o certificado rodando de um lugar e nao de outro.
  const pasta = resolve(RAIZ_PROJETO, expandirCaminho(config.certificados?.pastaPadrao ?? '.'));
  const bruto = expandirCaminho(declarado.arquivo ?? '');
  if (!bruto) return { erro: `${cliente.nome}: certificado sem "arquivo".` };

  const caminho = isAbsolute(bruto) ? bruto : resolve(pasta, bruto);

  if (dentroDoProjeto(caminho)) {
    return {
      erro:
        `${cliente.nome}: o certificado está dentro do projeto (${caminho}). Um .pfx commitado ` +
        'permanece no histórico do Git mesmo depois de apagado. Guarde-o ao lado do projeto, ' +
        'não dentro: uma pasta "Certificados" irmã da pasta do programa, configurada como ' +
        '"../Certificados".',
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
    // O nome da variavel nao diz nada para quem opera o painel. O que resolve
    // e a instrucao: validar a senha daquele certificado na aba Certificados.
    return {
      erro:
        `${cliente.nome}: a senha deste certificado ainda não foi validada. ` +
        'Abra a aba Certificados, informe a senha e clique em ler — o programa ' +
        'valida, guarda, e esta consulta passa a funcionar sozinha.',
    };
  }

  return { caminho, senha, variavel };
}

/**
 * Certificados disponiveis na pasta configurada.
 *
 * Devolve so o nome do arquivo -- o painel precisa de uma lista para escolher,
 * nao do caminho completo do disco do operador.
 */
export async function listarCertificados(pasta, raiz = RAIZ_PROJETO) {
  if (!pasta) return { pasta: null, arquivos: [], erro: null, dentroDoProjeto: false };

  const caminho = resolve(raiz, expandirCaminho(pasta));

  // Avisar aqui, no cadastro, e nao so quando a rodada falhar tres semanas
  // depois: o operador acabou de escolher a pasta e ainda pode mudar de ideia.
  const proibida = dentroDoProjeto(caminho, raiz);

  try {
    const entradas = await readdir(caminho, { withFileTypes: true });
    return {
      pasta: caminho,
      arquivos: entradas
        .filter((e) => e.isFile() && /\.(pfx|p12)$/i.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'pt-BR')),
      erro: null,
      dentroDoProjeto: proibida,
    };
  } catch {
    return {
      pasta: caminho,
      arquivos: [],
      erro: `Pasta não encontrada: ${caminho}`,
      dentroDoProjeto: proibida,
    };
  }
}
