import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { interpretarTexto } from '../src/situacao.js';
import { detectarCaptcha, esperarSeletor, primeiroSeletorPresente } from '../src/provedores/web.js';
import { receitaFormulario } from '../src/receitas/index.js';

test('irregular nao pode ser lido como negativa', () => {
  // "irregular" contem "regular": a ordem das regras e o que impede o falso ok.
  assert.equal(interpretarTexto('Empregador em situação IRREGULAR'), 'positiva');
  assert.equal(interpretarTexto('Empregador em situação regular'), 'negativa');
});

test('classifica os textos que os portais realmente usam', () => {
  assert.equal(interpretarTexto('Certidão Negativa de Débitos'), 'negativa');
  assert.equal(interpretarTexto('NADA CONSTA'), 'negativa');
  assert.equal(
    interpretarTexto('Certidão Positiva com Efeito de Negativa'),
    'positiva_com_efeito_negativo',
  );
  assert.equal(interpretarTexto('Constam pendências'), 'positiva');
  assert.equal(interpretarTexto('página em manutenção'), null);
});

test('"informações insuficientes" é o portal dizendo que não há CND', () => {
  // Texto exato devolvido pelo portal da Receita. Não traz nenhuma das
  // palavras-chave usuais, e ignorá-lo faria a rotina dizer "não reconhecida"
  // para o caso em que o cliente mais precisa de atenção.
  const texto =
    'As informações disponíveis na Receita Federal e na Procuradoria-Geral da ' +
    'Fazenda Nacional sobre o contribuinte 28.282.552/0001-59 são insuficientes ' +
    'para emitir a certidão pela Internet.';

  assert.equal(interpretarTexto(texto), 'nao_emitida');
  assert.equal(interpretarTexto('Não foi possível emitir a certidão'), 'nao_emitida');
});

test('não emitida conta como pendência e aparece em vermelho', async () => {
  const { descreverSituacao } = await import('../src/catalogo.js');
  const s = descreverSituacao('nao_emitida');

  assert.equal(s.pendencia, true);
  assert.equal(s.status, 'critical');
});

/**
 * Os testes abaixo exercitam a automacao ponta a ponta contra um portal falso
 * servido de file://. Cobrem tudo menos o acesso ao site real -- que nao da
 * para testar em CI sem depender da disponibilidade do orgao.
 */
describe('automação com navegador', async () => {
  let navegador;
  let pagina;

  before(async () => {
    try {
      const { chromium } = await import('playwright');
      navegador = await chromium.launch({
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
          : {}),
        args: ['--no-sandbox'],
      });
      pagina = await navegador.newPage();
    } catch {
      navegador = null; // Sem Playwright/Chromium: os testes se marcam como skip.
    }
  });

  after(async () => {
    await navegador?.close().catch(() => {});
  });

  test('detecta captcha antes de tentar ler a resposta', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    await pagina.setContent('<div class="g-recaptcha"></div>');
    assert.equal(await detectarCaptcha(pagina), '.g-recaptcha');

    await pagina.setContent('<form><input id="NI"></form>');
    assert.equal(await detectarCaptcha(pagina), null);
  });

  test('escolhe o primeiro seletor candidato que existe', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    await pagina.setContent('<input name="NI">');
    assert.equal(await primeiroSeletorPresente(pagina, ['#NI', 'input[name="NI"]']), 'input[name="NI"]');
    assert.equal(await primeiroSeletorPresente(pagina, ['#nada']), null);
  });

  test('espera o formulário que o SPA só renderiza depois', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    // O portal da Receita é um SPA: quando o goto retorna, o campo ainda não
    // existe. A sondagem instantânea daria falso negativo.
    await pagina.setContent(`
      <div id="app"></div>
      <script>
        setTimeout(() => {
          document.getElementById('app').innerHTML =
            '<input formcontrolname="cnpj">';
        }, 600);
      </script>`);

    assert.equal(
      await primeiroSeletorPresente(pagina, ['input[formcontrolname="cnpj"]']),
      null,
      'sondagem instantânea não enxerga o campo ainda não renderizado',
    );
    assert.equal(
      await esperarSeletor(pagina, ['input[formcontrolname="cnpj"]'], 5000),
      'input[formcontrolname="cnpj"]',
      'a espera enxerga',
    );
  });

  test('esperarSeletor desiste dentro do prazo quando nada aparece', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    await pagina.setContent('<p>sem formulário</p>');
    assert.equal(await esperarSeletor(pagina, ['#nunca'], 400), null);
  });

  test('preenche o formulário e extrai situação, validade e controle', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const pasta = await mkdtemp(join(tmpdir(), 'portal-'));
    const arquivo = join(pasta, 'portal.html');
    await writeFile(
      arquivo,
      `<!doctype html><meta charset="utf-8">
       <input id="NI">
       <button id="validar">Consultar</button>
       <script>
         document.getElementById('validar').onclick = () => {
           const doc = document.getElementById('NI').value;
           document.body.innerHTML =
             '<main id="idResultado">Certidão Negativa de Débitos para ' + doc +
             '. Válida até 01/02/2027. Código de Controle: A1B2.C3D4</main>';
         };
       </script>`,
      'utf8',
    );

    const receita = receitaFormulario({
      id: 'fixture',
      nome: 'Portal de teste',
      url: `file://${arquivo}`,
      formatoDocumento: 'digitos',
      seletores: {
        campoDocumento: ['#NI'],
        botaoEnviar: ['#validar'],
        alvoResultado: ['#idResultado'],
      },
    });

    await pagina.goto(receita.url);
    const resultado = await receita.executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
    });

    assert.equal(resultado.situacao, 'negativa');
    assert.equal(resultado.validaAte, '01/02/2027');
    assert.equal(resultado.numeroCertidao, 'A1B2.C3D4');
    assert.match(resultado.detalhe, /11222333000181/, 'o documento chegou ao formulário');
  });

  test('seletor que não casa vira erro explícito, não resultado inventado', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const receita = receitaFormulario({
      id: 'fixture',
      nome: 'Portal de teste',
      url: 'about:blank',
      seletores: { campoDocumento: ['#inexistente'], botaoEnviar: ['#tambem-nao'] },
    });

    await pagina.setContent('<p>portal mudou de layout</p>');
    const resultado = await receita.executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
    });

    assert.equal(resultado.situacao, 'erro');
    assert.match(resultado.detalhe, /calibrar/);
  });

  test('resposta irreconhecível não é classificada como negativa', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const receita = receitaFormulario({
      id: 'fixture',
      nome: 'Portal de teste',
      url: 'about:blank',
      seletores: {
        campoDocumento: ['#NI'],
        botaoEnviar: ['#validar'],
        alvoResultado: ['#saida'],
      },
    });

    await pagina.setContent(
      `<input id="NI"><button id="validar"></button><div id="saida">Sistema em manutenção</div>`,
    );
    const resultado = await receita.executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
    });

    assert.equal(resultado.situacao, 'erro');
    assert.match(resultado.detalhe, /não reconhecida/);
  });
});

test('a rota do portal da Receita segue o tipo do documento', async () => {
  const { RECEITAS } = await import('../src/receitas/index.js');

  assert.match(RECEITAS.rfb_pgfn.urlsPara({ tipo: 'cnpj' })[0], /#\/home\/cnpj$/);
  assert.match(RECEITAS.rfb_pgfn.urlsPara({ tipo: 'cpf' })[0], /#\/home\/cpf$/);
  // Portais sem rota por tipo continuam com a lista simples.
  assert.deepEqual(RECEITAS.cndt.urlsPara({ tipo: 'cnpj' }), RECEITAS.cndt.urls);
});
