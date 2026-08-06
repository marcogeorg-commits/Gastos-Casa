/**
 * De quem e cada certificado.
 *
 * A primeira tentativa foi deduzir pelo nome do arquivo, presumindo que ele
 * traria o CNPJ. Muitas autoridades certificadoras nomeiam assim, mas nem
 * todas: e comum o arquivo sair com o numero do pedido ou a data da emissao, e
 * ai a deducao falha -- pior, falha dizendo "nao existe certificado", com o
 * arquivo ali na pasta.
 *
 * Ler o documento de dentro do `.pfx` seria definitivo, mas o arquivo e
 * cifrado: exigiria a senha so para descobrir de quem ele e.
 *
 * Entao o operador escolhe uma vez, e este arquivo guarda a escolha. Nao guarda
 * senha nenhuma -- so a associacao documento -> nome do arquivo.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARQUIVO = 'vinculos.json';

const so = (v) => String(v ?? '').replace(/\D/g, '');

export async function lerVinculos(raiz = RAIZ) {
  try {
    const bruto = JSON.parse(await readFile(resolve(raiz, ARQUIVO), 'utf8'));
    return bruto && typeof bruto === 'object' ? bruto : {};
  } catch {
    return {};
  }
}

/** Guarda a escolha do operador. Silencioso: nao e motivo para abortar nada. */
export async function gravarVinculo(documento, arquivo, raiz = RAIZ) {
  const chave = so(documento);
  if (!chave || !arquivo) return;

  try {
    const atuais = await lerVinculos(raiz);
    atuais[chave] = String(arquivo);
    await writeFile(resolve(raiz, ARQUIVO), `${JSON.stringify(atuais, null, 2)}\n`, 'utf8');
  } catch {
    // Sem permissao de escrita a consulta continua valendo; so nao lembra.
  }
}

/**
 * Certificado deste documento: primeiro a escolha ja feita, depois o palpite
 * pelo nome do arquivo.
 *
 * A escolha do operador vem antes de proposito -- ele sabe de quem e o
 * certificado, o programa so adivinha.
 */
export function escolherCertificado(arquivos, documento, vinculos = {}) {
  const chave = so(documento);
  const escolhido = vinculos[chave];
  if (escolhido && arquivos.includes(escolhido)) return escolhido;

  if (chave.length !== 14 && chave.length !== 11) return null;
  const candidatos = arquivos.filter((nome) => so(nome).includes(chave));
  return candidatos.length === 1 ? candidatos[0] : null;
}
