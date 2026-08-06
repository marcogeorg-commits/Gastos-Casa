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
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chamadoDireto } from './executavel.js';
import { carregarAmbiente, temSenha } from './ambiente.js';
import { casarPorDocumento, listarCertificados } from './certificados.js';
import { PASTA_CERTIFICADOS_PADRAO, configAvulsa, credenciaisDoAmbiente } from './config.js';
import { executar } from './executor.js';
import { descreverSituacao } from './catalogo.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORTA_PADRAO = 8787;
const LIMITE_CORPO = 2 * 1024 * 1024;
const LIMITE_LINHAS = 500;
const LIMITE_AVULSA = 120_000;
// No assistido o relogio conta o tempo de uma pessoa resolvendo captchas, um
// por certidao. Dois minutos cortariam a consulta no meio do trabalho dela.
const LIMITE_AVULSA_ASSISTIDO = 900_000;

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

// Reexportada por conveniencia: o painel a consome atraves deste modulo.
export { listarCertificados };

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
  saida.certificados = {
    pastaPadrao: String(bruto.certificados?.pastaPadrao || PASTA_CERTIFICADOS_PADRAO).slice(0, 300),
  };
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
 * Garante que exista um `clientes.json`.
 *
 * Sem arquivo, o painel abre vazio e a primeira gravacao o cria sem a pasta de
 * certificados -- foi assim que uma carteira inteira sumiu de vista depois de
 * um `git pull` que removeu o arquivo do versionamento. Criar o esqueleto na
 * subida deixa o painel util desde o primeiro clique.
 */
export async function garantirCadastro(raiz = RAIZ) {
  const destino = resolve(raiz, 'clientes.json');
  if (await lerJson(destino)) return { criado: false, caminho: destino };

  const esqueleto = {
    provedorPadrao: 'auto',
    certificados: { pastaPadrao: PASTA_CERTIFICADOS_PADRAO },
    clientes: [],
  };
  await writeFile(destino, `${JSON.stringify(esqueleto, null, 2)}\n`, 'utf8');
  return { criado: true, caminho: destino };
}

async function montarEstado(raiz) {
  const config = (await lerJson(resolve(raiz, 'clientes.json'))) ?? {
    provedorPadrao: 'auto',
    certificados: { pastaPadrao: PASTA_CERTIFICADOS_PADRAO },
    clientes: [],
  };
  const indice = await lerJson(resolve(raiz, 'historico/index.json'));
  const competencias = indice?.competencias ?? [];
  const atual = competencias[0]
    ? await lerJson(resolve(raiz, `historico/${competencias[0].competencia}.json`))
    : null;

  const certificados = await listarCertificados(
    config.certificados?.pastaPadrao ?? PASTA_CERTIFICADOS_PADRAO,
    raiz,
  );

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

  // Consulta avulsa: um documento, resposta na hora, sem tocar no cadastro
  // nem no histórico. Roda neste processo mesmo — é uma pergunta curta, e
  // abrir um processo separado só para ela atrasaria a resposta.
  if (rota === '/api/avulsa' && req.method === 'POST') {
    const corpo = await lerCorpo(req);

    // Certificado da pasta, casado pelo CNPJ no nome do arquivo. É o que
    // torna "já tenho os certificados na pasta" suficiente para consultar.
    const config0 = (await lerJson(resolve(raiz, 'clientes.json'))) ?? {};
    const pasta = config0.certificados?.pastaPadrao ?? PASTA_CERTIFICADOS_PADRAO;
    const { arquivos } = await listarCertificados(pasta, raiz);

    const arquivo = corpo.certificado || casarPorDocumento(arquivos, corpo.documento);
    const senha = String(corpo.senha ?? '');

    // A senha vive só nesta requisição: entra num ambiente descartável passado
    // à execução e nunca é gravada em disco nem devolvida ao navegador.
    const VARIAVEL = 'SENHA_DESTA_CONSULTA';
    const ambiente = arquivo && senha ? { ...process.env, [VARIAVEL]: senha } : process.env;

    let config;
    try {
      config = configAvulsa({
        documento: corpo.documento,
        certidoes: corpo.certidoes,
        provedor: corpo.provedor ?? 'auto',
        municipio: corpo.municipio ?? null,
        dataNascimento: corpo.dataNascimento ?? null,
        certificados: { pastaPadrao: pasta },
        certificado: arquivo ? { arquivo, senhaVariavel: VARIAVEL } : null,
      });
    } catch (erro) {
      responderJson(res, 400, { erro: erro.message });
      return;
    }

    // Teto de tempo. O provedor "web" insiste no portal (tres tentativas com
    // 30s de espera), o que faz sentido numa rodada mensal desacompanhada e
    // nao faz nenhum com alguem esperando na frente da tela.
    const execucao = await Promise.race([
      executar(config, credenciaisDoAmbiente(ambiente), {
        // Assistido é sequencial: quem resolve o captcha é uma pessoa.
        concorrencia: corpo.provedor === 'assistido' ? 1 : 4,
        env: ambiente,
      }),
      new Promise((_, falhar) =>
        setTimeout(
          () =>
            falhar(
              new Error(
                corpo.provedor === 'assistido'
                  ? 'A consulta assistida passou de 15 minutos e foi interrompida.'
                  : 'A consulta passou de 2 minutos e foi interrompida. Os portais públicos ' +
                    'costumam estar lentos ou exigindo captcha — tente de novo, ou use o ' +
                    'modo assistido, que abre o portal preenchido para você resolver o captcha.',
              ),
            ),
          corpo.provedor === 'assistido' ? LIMITE_AVULSA_ASSISTIDO : LIMITE_AVULSA,
        ),
      ),
    ]);

    responderJson(res, 200, {
      documento: config.clientes[0].documentoFormatado,
      certificado: arquivo ?? null,
      avisos: execucao.avisos,
      resultados: execucao.resultados.map((r) => ({
        certidao: r.certidao,
        certidaoNome: r.certidaoNome,
        orgao: r.orgao,
        situacao: r.situacao,
        rotulo: descreverSituacao(r.situacao).rotulo,
        detalhe: r.detalhe ?? '',
        validaAte: r.validaAte ?? null,
        urlManual: r.urlManual ?? null,
      })),
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

if (chamadoDireto(import.meta.url)) {
  carregarAmbiente();
  await garantirCadastro();

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
