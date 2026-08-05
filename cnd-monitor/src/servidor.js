#!/usr/bin/env node
/**
 * Servidor estático mínimo para abrir o painel.
 *
 * Existe porque `file://` não permite `fetch` de arquivos vizinhos: aberto com
 * dois cliques, o painel não conseguiria ler `historico/` nem `clientes.json`.
 * Serve só a pasta do cnd-monitor, só em localhost, e não escreve nada.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORTA_PADRAO = 8787;

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Resolve o caminho pedido dentro da raiz.
 *
 * Devolve null para qualquer coisa que escape da pasta -- `../../.ssh/id_rsa` e
 * o caso classico, e um servidor de conveniencia nao pode ser a porta de saida
 * do disco.
 */
export function resolverCaminho(urlPedida, raiz = RAIZ) {
  const semQuery = decodeURIComponent(urlPedida.split('?')[0]);
  const relativo = normalize(semQuery).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const destino = resolve(raiz, relativo || 'painel/index.html');

  if (destino !== raiz && !destino.startsWith(raiz + sep)) return null;
  return destino;
}

export function criarServidor(raiz = RAIZ) {
  return createServer(async (req, res) => {
    const alvo = resolverCaminho(req.url ?? '/', raiz);
    if (!alvo) {
      res.writeHead(403).end('Fora da pasta servida.');
      return;
    }

    try {
      const info = await stat(alvo);
      const arquivo = info.isDirectory() ? join(alvo, 'index.html') : alvo;
      const conteudo = await readFile(arquivo);

      res.writeHead(200, {
        'Content-Type': TIPOS[extname(arquivo)] ?? 'application/octet-stream',
        // O painel lê JSON que a rotina acabou de gravar: cache atrapalha.
        'Cache-Control': 'no-store',
      });
      res.end(conteudo);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado.');
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const porta = Number(process.env.PORTA ?? PORTA_PADRAO);
  criarServidor().listen(porta, '127.0.0.1', () => {
    console.log(`Painel em http://localhost:${porta}/`);
    console.log('Ctrl+C para encerrar.');
  });
}
