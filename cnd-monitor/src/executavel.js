import { pathToFileURL } from 'node:url';

/**
 * Este arquivo foi chamado direto pela linha de comando?
 *
 * Todo modulo com CLI precisa distinguir "fui executado" de "fui importado por
 * um teste". O idioma comum e comparar `import.meta.url` com `file://` mais
 * `process.argv[1]` -- que parece equivalente e nao e: `import.meta.url` vem
 * percent-encoded (espaco vira %20, apostrofo pode virar %27) e o argv[1] vem
 * cru, do sistema de arquivos.
 *
 * Num caminho como `/Users/marco/LG IA's/Projetos Claude/CND` as duas strings
 * nunca coincidem. O bloco de entrada nao roda, nada e impresso e o processo
 * termina com codigo 0 -- a pior falha possivel, porque tem a cara de sucesso:
 * `npm start` volta ao prompt sem subir servidor nenhum e sem dizer por que.
 *
 * `pathToFileURL` faz a mesma codificacao que o Node usa em `import.meta.url`,
 * entao a comparacao passa a ser entre iguais.
 */
export function chamadoDireto(urlDoModulo, argv = process.argv) {
  if (!argv[1]) return false;

  try {
    return urlDoModulo === pathToFileURL(argv[1]).href;
  } catch {
    return false;
  }
}
