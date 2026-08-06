#!/usr/bin/env node
/**
 * Servidor local do painel.
 *
 * Tudo roda nesta maquina: o painel le e grava `clientes.json`, dispara a
 * rodada e acompanha o andamento. Nada sai daqui -- e essa e a condicao para
 * usar os certificados digitais dos clientes, que nao devem chegar a um
 * servidor na nuvem.
 *
 * Um servidor que grava arquivo e executa processo precisa de mais cuidado que
 * um que so serve HTML:
 *
 *   - escuta so em 127.0.0.1, nunca na rede;
 *   - toda rota de escrita exige um token sorteado a cada inicializacao, que o
 *     servidor injeta na propria pagina -- outra aba do navegador nao o tem;
 *   - confere a origem do pedido, para uma pagina qualquer aberta ao lado nao
 *     conseguir mandar apagar o cadastro;
 *   - nunca devolve senha, so se ela existe.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarAmbiente, temSenha } from './ambiente.js';
import { expandirCaminho } from './certificados.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORTA_PADRAO = 8787;
const LIMITE_CORPO = 2 * 1024 * 1024;
const LIMITE_LINHAS = 500;

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export const TOKEN = randomUUID();

/**
 * Nao servir, mesmo estando dentro da pasta.
 *
 * O `.env` guarda as senhas dos certificados e mora na raiz do projeto: sem
 * esta lista, `GET /.env` as entregaria a qualquer aba aberta no navegador --
 * nenhum token, porque arquivo estatico nao pede token. O `.git` guarda o
 * historico inteiro, que e pior ainda.
 */
const PROIBIDOS = [/^\.env/, /^\.git(\/|$)/, /^node_modules(\/|$)/, /^calibracao\/(falha|ecac)-/];

/**
 * Resolve o caminho pedido dentro da raiz.
 *
 * Devolve null para o que escape da pasta -- `../../.ssh/id_rsa` e o caso
 * classico, e um servidor de conveniencia nao pode ser a porta de saida do
 * disco -- e para o que esteja na lista de proibidos.
 */
export function resolverCaminho(urlPedida, raiz = RAIZ) {
  let semQuery;
  try {
    semQuery = decodeURIComponent(urlPedida.split('?')[0]);
  } catch {
    return null; // Percentual malformado: pedido que nenhum navegador faz.
  }

  const relativo = normalize(semQuery).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const destino = resolve(raiz, relativo || 'painel/index.html');

  if (destino !== raiz && !destino.startsWith(raiz + sep)) return null;

  const dentro = destino.slice(raiz.length + 1).split(sep).join('/');
  if (PROIBIDOS.some((padrao) => padrao.test(dentro))) return null;

  return destino;
}

/**
 * O pedido veio da propria pagina?
 *
 * Sem essa checagem, um site aberto noutra aba poderia mandar POST para
 * localhost. O navegador manda `Origin` em toda escrita entre origens, entao
 * origem estranha e recusa; ausencia de origem e chamada de linha de comando
 * na propria maquina, que ja passou pelo token.
 */
export function origemConfiavel(origem, porta) {
  if (!origem) return true;
  return [
    `http://localhost:${porta}`,
    `http://127.0.0.1:${porta}`,
    `http://[::1]:${porta}`,
  ].includes(origem);
}

/**
 * Guarda so o que o cadastro precisa ter.
 *
 * O painel manda o objeto inteiro de volta; sem esta peneira, um campo
 * inventado (ou uma `senha` digitada por engano) entraria no arquivo. A senha
 * do certificado e descartada de proposito: o lugar dela e o `.env`.
 */
export function sanearConfig(bruto) {
  const cliente = (c) => {
    const limpo = {
      nome: String(c.nome ?? '').slice(0, 200),
      documento: String(c.documento ?? '').slice(0, 30),
    };
    for (const campo of ['municipio', 'uf', 'dataNascimento', 'observacao']) {
      if (c[campo]) limpo[campo] = String(c[campo]).slice(0, 200);
    }
    if (Array.isArray(c.certidoes)) limpo.certidoes = c.certidoes.map(String);
    if (c.ativo === false) limpo.ativo = false;
    if (c.certificado?.arquivo) {
      limpo.certificado = {
        arquivo: String(c.certificado.arquivo).slice(0, 300),
        senhaVariavel: String(c.certificado.senhaVariavel ?? '')
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, '')
          .slice(0, 80),
      };
    }
    return limpo;
  };

  const saida = {
    provedorPadrao: String(bruto.provedorPadrao ?? 'mock'),
    clientes: (bruto.clientes ?? []).map(cliente),
  };
  if (bruto.certificados?.pastaPadrao) {
    saida.certificados = { pastaPadrao: String(bruto.certificados.pastaPadrao).slice(0, 300) };
  }
  if (bruto.provedores && typeof bruto.provedores === 'object') {
    saida.provedores = Object.fromEntries(
      Object.entries(bruto.provedores).map(([k, v]) => [String(k), String(v)]),
    );
  }
  if (Array.isArray(bruto.certidoes)) saida.certidoes = bruto.certidoes.map(String);
  return saida;
}

// --- Rodada em andamento ---------------------------------------------------

const rodada = { ativa: false, linhas: [], codigo: null, inicio: null, processo: null };

function registrar(texto) {
  for (const linha of String(texto).split('\n')) {
    if (!linha.trim()) continue;
    rodada.linhas.push(linha);
  }
  if (rodada.linhas.length > LIMITE_LINHAS) {
    rodada.linhas = rodada.linhas.slice(-LIMITE_LINHAS);
  }
}

function iniciarRodada(opcoes = {}, raiz = RAIZ) {
  if (rodada.ativa) return { erro: 'Já existe uma consulta em andamento.' };

  const args = [resolve(raiz, 'src/index.js')];
  if (opcoes.provedor) args.push('--provedor', String(opcoes.provedor));
  if (opcoes.competencia) args.push('--competencia', String(opcoes.competencia));

  rodada.ativa = true;
  rodada.linhas = [];
  rodada.codigo = null;
  rodada.inicio = new Date().toISOString();

  // `ECAC_HEADLESS=false` deixa o navegador visivel: quando a consulta depende
  // do certificado, o operador precisa ver o que o portal esta pedindo.
  const processo = spawn(process.execPath, args, {
    cwd: raiz,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  rodada.processo = processo;

  processo.stdout.setEncoding('utf8');
  processo.stderr.setEncoding('utf8');
  processo.stdout.on('data', registrar);
  processo.stderr.on('data', registrar);

  processo.on('error', (erro) => {
    registrar(`Não foi possível iniciar: ${erro.message}`);
    rodada.ativa = false;
    rodada.codigo = 1;
    rodada.processo = null;
  });
  processo.on('close', (codigo) => {
    rodada.ativa = false;
    rodada.codigo = codigo;
    rodada.processo = null;
  });

  return { iniciada: true };
}

// --- Leitura do estado -----------------------------------------------------

async function lerJson(caminho) {
  try {
    return JSON.parse(await readFile(caminho, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Certificados disponiveis na pasta configurada.
 *
 * Devolve so o nome do arquivo -- o painel precisa de uma lista para escolher,
 * nao do caminho completo do disco do operador.
 */
export async function listarCertificados(pasta) {
  if (!pasta) return { pasta: null, arquivos: [], erro: null };

  const caminho = expandirCaminho(pasta);
  try {
    const entradas = await readdir(caminho, { withFileTypes: true });
    return {
      pasta: caminho,
      arquivos: entradas
        .filter((e) => e.isFile() && /\.(pfx|p12)$/i.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'pt-BR')),
      erro: null,
    };
  } catch {
    return { pasta: caminho, arquivos: [], erro: `Pasta não encontrada: ${caminho}` };
  }
}

async function montarEstado(raiz) {
  const config = (await lerJson(resolve(raiz, 'clientes.json'))) ?? {
    provedorPadrao: 'mock',
    clientes: [],
  };
  const indice = await lerJson(resolve(raiz, 'historico/index.json'));
  const competencias = indice?.competencias ?? [];
  const atual = competencias[0]
    ? await lerJson(resolve(raiz, `historico/${competencias[0].competencia}.json`))
    : null;

  const certificados = await listarCertificados(config.certificados?.pastaPadrao);

  // Só o "tem ou não tem": a senha em si não sobe para o navegador.
  const senhas = {};
  for (const c of config.clientes ?? []) {
    const variavel = c.certificado?.senhaVariavel;
    if (variavel) senhas[variavel] = temSenha(variavel);
  }

  return { config, competencias, atual, certificados, senhas };
}

// --- Servidor --------------------------------------------------------------

function responderJson(res, codigo, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(texto);
}

async function lerCorpo(req) {
  const partes = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > LIMITE_CORPO) throw new Error('Corpo grande demais.');
    partes.push(parte);
  }
  return JSON.parse(Buffer.concat(partes).toString('utf8') || '{}');
}

async function tratarApi(req, res, rota, raiz, porta) {
  if (req.headers['x-token'] !== TOKEN) {
    responderJson(res, 403, { erro: 'Token inválido. Recarregue o painel.' });
    return;
  }
  if (!origemConfiavel(req.headers.origin, porta)) {
    responderJson(res, 403, { erro: 'Origem não autorizada.' });
    return;
  }

  if (rota === '/api/estado' && req.method === 'GET') {
    responderJson(res, 200, await montarEstado(raiz));
    return;
  }

  if (rota === '/api/clientes' && req.method === 'POST') {
    const corpo = await lerCorpo(req);
    const config = sanearConfig(corpo);
    const destino = resolve(raiz, 'clientes.json');

    // Uma gravacao ruim nao pode ser a unica copia: guarda a anterior antes.
    await mkdir(resolve(raiz, 'historico'), { recursive: true });
    await copyFile(destino, resolve(raiz, 'historico/clientes.anterior.json')).catch(() => {});
    await writeFile(destino, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    responderJson(res, 200, { gravado: true, clientes: config.clientes.length });
    return;
  }

  if (rota === '/api/rodada' && req.method === 'POST') {
    const corpo = await lerCorpo(req);
    const resultado = iniciarRodada(corpo, raiz);
    responderJson(res, resultado.erro ? 409 : 200, resultado);
    return;
  }

  if (rota === '/api/rodada' && req.method === 'GET') {
    responderJson(res, 200, {
      ativa: rodada.ativa,
      linhas: rodada.linhas,
      codigo: rodada.codigo,
      inicio: rodada.inicio,
    });
    return;
  }

  if (rota === '/api/rodada/parar' && req.method === 'POST') {
    rodada.processo?.kill('SIGTERM');
    responderJson(res, 200, { parada: true });
    return;
  }

  responderJson(res, 404, { erro: 'Rota desconhecida.' });
}

export function criarServidor(raiz = RAIZ, porta = PORTA_PADRAO) {
  return createServer(async (req, res) => {
    const rota = (req.url ?? '/').split('?')[0];

    try {
      if (rota.startsWith('/api/')) {
        await tratarApi(req, res, rota, raiz, porta);
        return;
      }

      const alvo = resolverCaminho(req.url ?? '/', raiz);
      if (!alvo) {
        res.writeHead(403).end('Fora da pasta servida.');
        return;
      }

      const info = await stat(alvo);
      const arquivo = info.isDirectory() ? join(alvo, 'index.html') : alvo;
      let conteudo = await readFile(arquivo);

      // O token entra na pagina servida, nao numa rota que qualquer aba possa
      // pedir. E por isso que o painel so funciona atraves deste servidor.
      if (extname(arquivo) === '.html') {
        conteudo = conteudo.toString('utf8').replace('__TOKEN_DO_PAINEL__', TOKEN);
      }

      res.writeHead(200, {
        'Content-Type': TIPOS[extname(arquivo)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(conteudo);
    } catch (erro) {
      if (rota.startsWith('/api/')) {
        responderJson(res, 400, { erro: erro.message });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado.');
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  carregarAmbiente();

  const porta = Number(process.env.PORTA ?? PORTA_PADRAO);
  const endereco = `http://localhost:${porta}/`;

  criarServidor(RAIZ, porta).listen(porta, '127.0.0.1', () => {
    console.log(`\n  ABC.inc & EMBRALOT — Monitor de Certidões`);
    console.log(`  ${endereco}`);
    console.log(`\n  Só nesta máquina. Ctrl+C para encerrar.\n`);

    if (process.env.ABRIR !== 'nao') {
      const abridor =
        process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(abridor, [endereco], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
        .on('error', () => {})
        .unref();
    }
  });
}
