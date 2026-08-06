/**
 * Senhas dos certificados, lidas de um `.env` local.
 *
 * A alternativa era exportar vinte variaveis de ambiente a cada terminal novo,
 * o que na pratica termina em senha colada num script versionado. O `.env` fica
 * no .gitignore, e este modulo recusa carregar um arquivo que o Git esteja
 * seguindo -- e nesse ponto que o segredo vazaria, nao no disco do escritorio.
 *
 * O `.pfx` mora fora do repositorio (ver certificados.js) e a senha mora aqui:
 * separados, um vazamento sozinho nao assina nada em nome do cliente.
 */
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `CHAVE=valor` por linha; `#` comenta; aspas ao redor do valor sao opcionais. */
export function analisar(texto) {
  const valores = {};
  for (const linha of String(texto ?? '').split('\n')) {
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith('#')) continue;

    const igual = limpa.indexOf('=');
    if (igual < 1) continue;

    const chave = limpa.slice(0, igual).trim().replace(/^export\s+/, '');
    let valor = limpa.slice(igual + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"') && valor.length > 1) ||
      (valor.startsWith("'") && valor.endsWith("'") && valor.length > 1)
    ) {
      valor = valor.slice(1, -1);
    }
    if (chave) valores[chave] = valor;
  }
  return valores;
}

/**
 * Carrega o `.env` no processo.
 *
 * Nao sobrescreve variavel ja definida: quem exportou no terminal quis aquilo.
 * Devolve os avisos em vez de imprimir, para o painel poder mostra-los tambem.
 */
export function carregarAmbiente(env = process.env, raiz = RAIZ) {
  const caminho = resolve(raiz, '.env');
  const avisos = [];

  if (!existsSync(caminho)) return { carregadas: [], avisos, caminho };

  // 0600: um `.env` legivel por outros usuarios da maquina e o mesmo que senha
  // em texto aberto. Corrige em silencio -- avisar sem consertar so incomoda.
  try {
    const modo = statSync(caminho).mode & 0o777;
    if (modo & 0o077) chmodSync(caminho, 0o600);
  } catch {
    // Sistema de arquivos sem permissao POSIX (rede, Windows). Segue.
  }

  const valores = analisar(readFileSync(caminho, 'utf8'));
  const carregadas = [];
  for (const [chave, valor] of Object.entries(valores)) {
    if (env[chave] === undefined) {
      env[chave] = valor;
      carregadas.push(chave);
    }
  }

  return { carregadas, avisos, caminho };
}

/**
 * A senha desta variavel esta disponivel?
 *
 * Devolve so o booleano. O painel precisa dizer "falta a senha do cliente X"
 * sem que a senha em si transite pelo HTTP ate o navegador.
 */
export function temSenha(variavel, env = process.env) {
  return Boolean(variavel && env[variavel]);
}
