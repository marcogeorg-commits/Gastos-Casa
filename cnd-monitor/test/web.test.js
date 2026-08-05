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

  test('desafio com tamanho na tela bloqueia', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    // Caixa "não sou um robô": ocupa espaço, exige clique humano.
    await pagina.setContent('<div class="g-recaptcha" style="width:304px;height:78px"></div>');
    const visivel = await detectarCaptcha(pagina);
    assert.equal(visivel.provedor, 'reCAPTCHA');
    assert.equal(visivel.bloqueante, true);
  });

  test('hCaptcha invisível é detectado sem bloquear a consulta', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    // Como no portal da Receita: vários iframes de serviço, nenhum visível ao
    // usuário, e um deles sem a marca "invisible" no src. Decidir pela URL
    // classificava isso como visível e recusava a consulta sem tentar.
    await pagina.setContent(`
      <iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox"
              style="display:none"></iframe>
      <iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge&recaptchacompat=true&size=invisible"
              style="width:1px;height:1px"></iframe>
      <textarea id="g-recaptcha-response-abc" style="display:none"></textarea>`);

    const achado = await detectarCaptcha(pagina);
    assert.equal(achado.provedor, 'hCaptcha', 'hcaptcha vem antes de recaptchacompat');
    assert.equal(achado.invisivel, true);
    assert.equal(achado.bloqueante, false, 'não pode recusar a consulta sem tentar');
  });

  test('campo oculto de captcha sozinho não bloqueia', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    // O campo de resposta existe desde que o script carrega, antes de qualquer
    // desafio. Tratá-lo como bloqueio recusaria toda consulta.
    await pagina.setContent('<textarea id="h-captcha-response-xyz" style="display:none"></textarea>');
    const achado = await detectarCaptcha(pagina);
    assert.equal(achado.bloqueante, false);

    await pagina.setContent('<form><input id="NI"></form>');
    assert.equal(await detectarCaptcha(pagina), null);
  });

  test('o campo do CNPJ não pode casar com a busca do topo do site', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const { RECEITAS } = await import('../src/receitas/index.js');

    // Layout do portal: a busca do site vem antes do formulário no DOM.
    await pagina.setContent(`
      <input id="searchbox" type="text" placeholder="O que você procura?">
      <br-input><input id="id3f7317eeae4b2c" type="text" placeholder="Informe o CNPJ"></br-input>`);

    const escolhido = await esperarSeletor(
      pagina,
      RECEITAS.rfb_pgfn.seletores.campoDocumento,
      3000,
    );
    const id = await pagina.locator(escolhido).first().getAttribute('id');
    assert.notEqual(id, 'searchbox', 'ia digitar o CNPJ na busca do site');
    assert.equal(id, 'id3f7317eeae4b2c');
  });

  test('a preparação tira a barra de cookies da frente', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const receita = receitaFormulario({
      id: 'fixture',
      nome: 'Portal de teste',
      url: 'about:blank',
      preparacao: [{ descricao: 'cookies', candidatos: ['button:has-text("Aceitar")'] }],
      seletores: {
        campoDocumento: ['#NI'],
        botaoEnviar: ['#validar'],
        alvoResultado: ['#saida'],
      },
    });

    await pagina.setContent(`
      <button onclick="document.getElementById('barra').remove()">Aceitar</button>
      <div id="barra">cookies</div>
      <input id="NI">
      <button id="validar" onclick="document.getElementById('saida').textContent='Certidão Negativa'"></button>
      <div id="saida"></div>`);

    const resultado = await receita.executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      esperarSeletor,
    });

    assert.equal(resultado.situacao, 'negativa');
    assert.equal(await pagina.locator('#barra').count(), 0, 'a barra foi aceita');
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

/**
 * O inventário da calibração precisa enxergar o que o Playwright enxerga.
 * Um SPA renderiza tarde e pode montar campos dentro de shadow DOM -- se o
 * inventário perder qualquer um dos dois casos, o diagnóstico diz "portal sem
 * campos" e manda caçar o problema no lugar errado.
 */
describe('inventário da calibração', async () => {
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
      navegador = null;
    }
  });

  after(async () => {
    await navegador?.close().catch(() => {});
  });

  test('enxerga campos renderizados tarde e dentro de shadow DOM', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const { esperarApp, inventariar } = await import('../src/calibrar.js');

    await pagina.setContent(`
      <div id="app"></div>
      <div id="hospedeiro"></div>
      <script>
        setTimeout(() => {
          document.getElementById('app').innerHTML =
            '<input formcontrolname="cnpj" placeholder="Informe o CNPJ">' +
            '<button type="submit">Consultar</button>';
          const sombra = document.getElementById('hospedeiro').attachShadow({ mode: 'open' });
          sombra.innerHTML = '<input id="dentroDaSombra">';
        }, 500);
      </script>`);

    assert.equal(await esperarApp(pagina, 8000), true);

    const inventario = await inventariar(pagina);
    const seletores = inventario.campos.map((c) => c.seletor);

    assert.ok(
      seletores.includes('input[formcontrolname="cnpj"]'),
      `campo renderizado tarde não foi visto: ${JSON.stringify(seletores)}`,
    );
    assert.ok(
      seletores.includes('#dentroDaSombra'),
      `campo em shadow DOM não foi visto: ${JSON.stringify(seletores)}`,
    );
    assert.equal(inventario.botoes.length, 1);
  });

  test('sem controle nenhum, devolve o texto da página para diagnóstico', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const { esperarApp, inventariar } = await import('../src/calibrar.js');

    await pagina.setContent('<p>Serviço temporariamente indisponível</p>');
    assert.equal(await esperarApp(pagina, 800), false);

    const inventario = await inventariar(pagina);
    assert.equal(inventario.campos.length, 0);
    assert.match(inventario.textoVisivel, /temporariamente indisponível/);
  });
});
