import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { carregarConfig, credenciaisDoAmbiente, provedorDe } from '../src/config.js';
import { executar, resumir } from '../src/executor.js';
import { gerarHtml } from '../src/relatorio.js';
import { interpretarSituacao } from '../src/provedores/infosimples.js';

async function configTemporaria(conteudo) {
  const pasta = await mkdtemp(join(tmpdir(), 'cnd-'));
  const caminho = join(pasta, 'clientes.json');
  await writeFile(caminho, JSON.stringify(conteudo), 'utf8');
  return carregarConfig(caminho);
}

const BASE = {
  provedorPadrao: 'mock',
  certidoes: ['rfb_pgfn', 'cadin_federal', 'sefaz_sc', 'municipal'],
};

test('descarta cliente com documento invalido e registra aviso', async () => {
  const config = await configTemporaria({
    ...BASE,
    clientes: [
      { nome: 'Boa Ltda', documento: '11.222.333/0001-81', municipio: 'Blumenau' },
      { nome: 'Ruim Ltda', documento: '11.222.333/0001-99' },
    ],
  });

  assert.equal(config.clientes.length, 1);
  assert.match(config.avisos.join(' '), /Ruim Ltda.*dígito verificador inválido/);
});

test('certidao restrita a CNPJ nao entra para pessoa fisica', async () => {
  const config = await configTemporaria({
    ...BASE,
    clientes: [{ nome: 'Fulano', documento: '123.456.780-62' }],
  });

  const [cliente] = config.clientes;
  assert.equal(cliente.tipo, 'cpf');
  assert.deepEqual(cliente.certidoes, ['rfb_pgfn', 'cadin_federal']);
});

test('certidao municipal exige o municipio no cadastro', async () => {
  const config = await configTemporaria({
    ...BASE,
    clientes: [{ nome: 'Sem Municipio Ltda', documento: '11.222.333/0001-81' }],
  });

  assert.ok(!config.clientes[0].certidoes.includes('municipal'));
  assert.match(config.avisos.join(' '), /exige o campo "municipio"/);
});

test('override por certidao vence o provedor padrao', async () => {
  const config = await configTemporaria({
    ...BASE,
    provedores: { rfb_pgfn: 'serpro' },
    clientes: [{ nome: 'Alfa Ltda', documento: '11.222.333/0001-81', municipio: 'Blumenau' }],
  });

  assert.equal(provedorDe(config, 'rfb_pgfn'), 'serpro');
  assert.equal(provedorDe(config, 'sefaz_sc'), 'mock');
});

test('provedor sem credencial vira falha explicita, sem derrubar a rodada', async () => {
  const config = await configTemporaria({
    provedorPadrao: 'infosimples',
    certidoes: ['rfb_pgfn'],
    clientes: [{ nome: 'Alfa Ltda', documento: '11.222.333/0001-81' }],
  });

  const execucao = await executar(config, credenciaisDoAmbiente({}), { concorrencia: 1 });

  assert.equal(execucao.resultados[0].situacao, 'erro');
  assert.match(execucao.resultados[0].detalhe, /INFOSIMPLES_TOKEN/);
  assert.match(execucao.avisos.join(' '), /sem credenciais/);
});

test('CADIN federal nao consulta rede e cai em conferencia manual', async () => {
  const config = await configTemporaria({
    provedorPadrao: 'infosimples',
    certidoes: ['cadin_federal'],
    clientes: [{ nome: 'Alfa Ltda', documento: '11.222.333/0001-81' }],
  });

  const execucao = await executar(config, credenciaisDoAmbiente({}), { concorrencia: 1 });
  const [resultado] = execucao.resultados;

  assert.equal(resultado.situacao, 'manual');
  assert.equal(resultado.provedor, null);
  assert.match(resultado.detalhe, /e-CAC/);
  // Manual nao conta como pendencia -- senao todo cliente apareceria em vermelho.
  assert.equal(execucao.resumo.clientesComPendencia, 0);
  assert.equal(execucao.resumo.manuais, 1);
});

test('resumir conta clientes distintos, nao consultas', () => {
  const resumo = resumir([
    { documento: 'A', situacao: 'positiva' },
    { documento: 'A', situacao: 'positiva' },
    { documento: 'B', situacao: 'negativa' },
  ]);

  assert.equal(resumo.consultas, 3);
  assert.equal(resumo.clientes, 2);
  assert.equal(resumo.clientesComPendencia, 1);
});

test('interpreta o texto da certidao em situacoes normalizadas', () => {
  assert.equal(interpretarSituacao('Certidão Negativa de Débitos'), 'negativa');
  assert.equal(
    interpretarSituacao('Certidão Positiva com Efeito de Negativa'),
    'positiva_com_efeito_negativo',
  );
  assert.equal(interpretarSituacao('Certidão Positiva'), 'positiva');
  assert.equal(interpretarSituacao('Há pendências'), 'positiva', 'aceita texto acentuado');
  assert.equal(interpretarSituacao(''), null);
});

test('o relatorio sai completo e escapa o cadastro', async () => {
  const config = await configTemporaria({
    ...BASE,
    clientes: [
      { nome: 'Alfa <script>alert(1)</script> Ltda', documento: '11.222.333/0001-81', municipio: 'Blumenau' },
    ],
  });

  const execucao = await executar(config, credenciaisDoAmbiente({}), { concorrencia: 1 });
  const html = gerarHtml({ competencia: '2026-08', execucao, config });

  assert.match(html, /<html lang="pt-BR">/);
  assert.match(html, /agosto de 2026/);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'nome do cliente deve sair escapado');
  assert.match(html, /&lt;script&gt;/);
});
