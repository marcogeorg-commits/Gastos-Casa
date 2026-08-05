import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buscarComRetentativa, ehTransitorio, esperaSugerida } from '../src/http.js';
import { coletarSegredos, criarRedator } from '../src/segredos.js';
import { carregarConfig, credenciaisDoAmbiente } from '../src/config.js';
import { executar, planejar } from '../src/executor.js';

async function configTemporaria(conteudo) {
  const pasta = await mkdtemp(join(tmpdir(), 'cnd-'));
  const caminho = join(pasta, 'clientes.json');
  await writeFile(caminho, JSON.stringify(conteudo), 'utf8');
  return carregarConfig(caminho);
}

const resposta = (status, cabecalhos = {}) => ({
  status,
  ok: status < 400,
  headers: { get: (k) => cabecalhos[k.toLowerCase()] ?? null },
});

test('só 429, 408 e 5xx merecem nova tentativa', () => {
  assert.equal(ehTransitorio(429), true);
  assert.equal(ehTransitorio(503), true);
  assert.equal(ehTransitorio(408), true);
  // Insistir em 401 ou 404 só queima cota: o erro é nosso, não do servidor.
  assert.equal(ehTransitorio(401), false);
  assert.equal(ehTransitorio(404), false);
  assert.equal(ehTransitorio(200), false);
});

test('respeita o Retry-After quando o servidor manda esperar', () => {
  assert.equal(esperaSugerida(resposta(429, { 'retry-after': '5' }), 1), 5000);
  // Sem cabeçalho, backoff exponencial.
  assert.equal(esperaSugerida(resposta(503), 1), 1000);
  assert.equal(esperaSugerida(resposta(503), 3), 4000);
  // Servidor pedindo espera absurda não trava a rodada.
  assert.equal(esperaSugerida(resposta(429, { 'retry-after': '9999' }), 1), 30_000);
});

test('pico momentâneo no provedor não vira falha no relatório', async () => {
  let chamadas = 0;
  const buscar = async () => {
    chamadas += 1;
    return chamadas < 3 ? resposta(503) : resposta(200);
  };

  const r = await buscarComRetentativa('https://exemplo', {}, { buscar, dormir: async () => {} });

  assert.equal(r.status, 200);
  assert.equal(chamadas, 3);
});

test('erro definitivo volta na primeira tentativa, sem insistir', async () => {
  let chamadas = 0;
  const buscar = async () => {
    chamadas += 1;
    return resposta(401);
  };

  const r = await buscarComRetentativa('https://exemplo', {}, { buscar, dormir: async () => {} });

  assert.equal(r.status, 401);
  assert.equal(chamadas, 1);
});

test('esgotadas as tentativas, devolve a última resposta em vez de estourar', async () => {
  const buscar = async () => resposta(503);
  const r = await buscarComRetentativa(
    'https://exemplo',
    {},
    { buscar, dormir: async () => {}, tentativas: 2 },
  );

  assert.equal(r.status, 503);
});

test('credencial ecoada pela API não chega ao histórico', () => {
  // O histórico é versionado; um token vazado ali fica no Git para sempre.
  const credenciais = credenciaisDoAmbiente({
    INFOSIMPLES_TOKEN: 'tok_secreto_123456',
    SERPRO_CONSUMER_KEY: 'chave_serpro_abcdef',
    SERPRO_CONSUMER_SECRET: 'segredo_serpro_uvxyz',
  });
  const redigir = criarRedator(credenciais, {});

  assert.equal(
    redigir('erro ao autenticar com token=tok_secreto_123456 na chamada'),
    'erro ao autenticar com token=[oculto] na chamada',
  );
  assert.equal(redigir('chave_serpro_abcdef e segredo_serpro_uvxyz'), '[oculto] e [oculto]');
  assert.equal(redigir('texto sem segredo'), 'texto sem segredo');
  assert.equal(redigir(null), null);
});

test('valor curto demais não vira máscara indiscriminada', () => {
  // Um token "abc" mascararia toda ocorrência de "abc" em qualquer texto.
  const segredos = coletarSegredos({ infosimples: { token: 'abc' } }, {});
  assert.deepEqual(segredos, []);

  const redigir = criarRedator({ infosimples: { token: 'abc' } }, {});
  assert.equal(redigir('abcdefgh'), 'abcdefgh');
});

test('o plano mostra quantas consultas seriam cobradas, sem tocar na rede', async () => {
  const config = await configTemporaria({
    provedorPadrao: 'infosimples',
    provedores: { rfb_pgfn: 'serpro', cndt: 'web' },
    certidoes: ['rfb_pgfn', 'cadin_federal', 'cndt', 'fgts_crf'],
    clientes: [
      { nome: 'Alfa', documento: '11.222.333/0001-81' },
      { nome: 'Beta', documento: '22.333.444/0001-81' },
    ],
  });

  const plano = planejar(config);

  assert.equal(plano.total, 8);
  assert.deepEqual(plano.porProvedor, { serpro: 2, manual: 2, web: 2, infosimples: 2 });
  // Nem manual nem web custam por consulta.
  assert.equal(plano.cobraveis, 4);
});

test('teto de gasto aborta antes de consultar, não no meio', async () => {
  const config = await configTemporaria({
    provedorPadrao: 'infosimples',
    certidoes: ['rfb_pgfn', 'cndt'],
    limiteConsultas: 3,
    clientes: [
      { nome: 'Alfa', documento: '11.222.333/0001-81' },
      { nome: 'Beta', documento: '22.333.444/0001-81' },
    ],
  });

  await assert.rejects(
    () => executar(config, credenciaisDoAmbiente({ INFOSIMPLES_TOKEN: 'x'.repeat(20) })),
    /4 consultas cobradas, acima do limite de 3/,
  );
});

test('sem limite configurado, a rodada segue normalmente', async () => {
  const config = await configTemporaria({
    provedorPadrao: 'mock',
    certidoes: ['rfb_pgfn'],
    clientes: [{ nome: 'Alfa', documento: '11.222.333/0001-81' }],
  });

  const execucao = await executar(config, credenciaisDoAmbiente({}));
  assert.equal(execucao.resultados.length, 1);
});
