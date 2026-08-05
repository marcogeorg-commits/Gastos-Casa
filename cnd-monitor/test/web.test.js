import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { interpretarTexto } from '../src/situacao.js';
import {
  detectarCaptcha,
  esperarSeletor,
  primeiroSeletorPresente,
  primeiroVisivel,
} from '../src/provedores/web.js';
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
  assert.equal(interpretarTexto('texto sem relação alguma'), null);
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
      // Sem retentativa: aqui o alvo é a resposta desconhecida, não o portal
      // instável — insistir só embaralharia o que está sendo verificado.
      tentativasPortal: 1,
      seletores: {
        campoDocumento: ['#NI'],
        botaoEnviar: ['#validar'],
        alvoResultado: ['#saida'],
      },
    });

    await pagina.setContent(
      `<input id="NI"><button id="validar"></button><div id="saida">Bem-vindo ao portal</div>`,
    );
    const resultado = await receita.executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      esperarSeletor,
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

test('"tente novamente em alguns minutos" é o portal fora do ar, não pendência', () => {
  // Texto exato do portal da Receita (erro 023). Sem tratamento próprio, cairia
  // em "resposta não reconhecida" — e uma empresa regular apareceria com
  // problema só porque o sistema piscou.
  const texto =
    'Não foi possível concluir a ação para o contribuinte informado. ' +
    'Por favor, tente novamente dentro de alguns minutos. 023 - 05/08/2026 15:54:23';

  assert.equal(interpretarTexto(texto), 'indisponivel');
  assert.equal(interpretarTexto('Sistema indisponível'), 'indisponivel');
  assert.equal(interpretarTexto('Serviço em manutenção'), 'indisponivel');
});

test('indisponível é falha de sistema, não débito do cliente', async () => {
  const { descreverSituacao } = await import('../src/catalogo.js');
  const indisponivel = descreverSituacao('indisponivel');
  const debito = descreverSituacao('positiva');

  assert.equal(indisponivel.pendencia, true, 'a certidão continua faltando');
  assert.notEqual(indisponivel.status, debito.status, 'não pode parecer débito');
  assert.match(indisponivel.rotulo, /indisponível/i);
});

describe('retentativa quando o portal pisca', async () => {
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

  /** Portal que falha nas primeiras `falhas` tentativas e depois responde. */
  async function portalInstavel(falhas) {
    const pasta = await mkdtemp(join(tmpdir(), 'instavel-'));
    const arquivo = join(pasta, 'portal.html');
    await writeFile(
      arquivo,
      `<!doctype html><meta charset="utf-8">
       <input id="NI"><button id="ir">Consultar</button><div id="saida"></div>
       <script>
         const chave = 'tentativas';
         document.getElementById('ir').onclick = () => {
           const n = Number(sessionStorage.getItem(chave) ?? 0) + 1;
           sessionStorage.setItem(chave, String(n));
           document.getElementById('saida').textContent = n <= ${falhas}
             ? 'Não foi possível concluir a ação para o contribuinte informado. Por favor, tente novamente dentro de alguns minutos. 023'
             : 'Certidão Negativa de Débitos';
         };
       </script>`,
      'utf8',
    );
    return `file://${arquivo}`;
  }

  const receitaTeste = (tentativasPortal) =>
    receitaFormulario({
      id: 'fixture',
      nome: 'Portal instável',
      url: 'about:blank',
      tentativasPortal,
      seletores: {
        campoDocumento: ['#NI'],
        botaoEnviar: ['#ir'],
        alvoResultado: ['#saida'],
      },
    });

  test('insiste e aceita a resposta que vem depois do soluço', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    await pagina.goto(await portalInstavel(1));
    const resultado = await receitaTeste(3).executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      esperarSeletor,
      dormir: async () => {}, // sem espera real no teste
    });

    assert.equal(resultado.situacao, 'negativa');
  });

  test('portal insistentemente fora do ar vira indisponível, não débito', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    await pagina.goto(await portalInstavel(99));
    const resultado = await receitaTeste(2).executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      esperarSeletor,
      dormir: async () => {},
    });

    assert.equal(resultado.situacao, 'indisponivel');
    assert.match(resultado.detalhe, /após 2 tentativas/);
  });
});

describe('leitura do desfecho', async () => {
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

  const receitaTeste = () =>
    receitaFormulario({
      id: 'fixture',
      nome: 'Portal de teste',
      url: 'about:blank',
      tentativasPortal: 1,
      seletores: {
        campoDocumento: ['#NI'],
        botaoEnviar: ['#ir'],
        alvoResultado: ['br-alert-messages', 'app-resultado', 'main'],
      },
    });

  /**
   * Foi assim que a consulta real falhou: o portal pôs a mensagem no alerta do
   * topo e deixou `app-resultado` vazio. Aceitar texto vazio produzia
   * "resposta não reconhecida" com a mensagem bem visível na tela.
   */
  test('container vazio não engole a mensagem que está no alerta', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    await pagina.setContent(`
      <input id="NI"><button id="ir"></button>
      <br-alert-messages></br-alert-messages>
      <app-resultado></app-resultado>
      <main>Certidão de Pessoa Jurídica</main>
      <script>
        document.getElementById('ir').onclick = () => {
          document.querySelector('br-alert-messages').textContent =
            'Não foi possível concluir a ação para o contribuinte informado. Por favor, tente novamente dentro de alguns minutos. 023';
        };
      </script>`);

    const resultado = await receitaTeste().executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      esperarSeletor,
      dormir: async () => {},
    });

    assert.equal(resultado.situacao, 'indisponivel');
    assert.match(resultado.detalhe, /tente novamente/);
  });

  test('sem alerta, lê o resultado de verdade', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    await pagina.setContent(`
      <input id="NI"><button id="ir"></button>
      <br-alert-messages></br-alert-messages>
      <app-resultado></app-resultado>
      <main></main>
      <script>
        document.getElementById('ir').onclick = () => {
          document.querySelector('app-resultado').textContent =
            'Certidão Negativa de Débitos. Válida até 01/02/2027.';
        };
      </script>`);

    const resultado = await receitaTeste().executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      esperarSeletor,
      dormir: async () => {},
    });

    assert.equal(resultado.situacao, 'negativa');
    assert.equal(resultado.validaAte, '01/02/2027');
  });

  test('página muda sem texto nenhum vira erro claro, não "não reconhecida"', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    await pagina.setContent(
      `<input id="NI"><button id="ir"></button><app-resultado></app-resultado>`,
    );

    const resultado = await receitaTeste().executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      esperarSeletor,
      dormir: async () => {},
    });

    assert.equal(resultado.situacao, 'erro');
    assert.match(resultado.detalhe, /não trouxe texto/);
  });

  test('seletor específico vence o genérico quando ambos já estão na página', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    // `Promise.any` devolvia quem resolvesse primeiro, e `body` sempre ganharia.
    await pagina.setContent('<app-resultado>alvo certo</app-resultado>');
    assert.equal(
      await esperarSeletor(pagina, ['app-resultado', 'body'], 3000),
      'app-resultado',
    );
  });
});

describe('espera do desfecho', async () => {
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

  /**
   * O portal responde com alerta e sem mudar de rota. Esperar só pela URL
   * gastava 45s por tentativa — três tentativas viravam minutos de silêncio,
   * indistinguíveis de travamento.
   */
  test('alerta encerra a espera sem depender da rota mudar', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const receita = receitaFormulario({
      id: 'fixture',
      nome: 'Portal de teste',
      url: 'about:blank',
      tentativasPortal: 1,
      urlResultado: /nunca-vai-casar/,
      sinaisResultado: ['br-alert-messages'],
      seletores: {
        campoDocumento: ['#NI'],
        botaoEnviar: ['#ir'],
        alvoResultado: ['br-alert-messages', 'main'],
      },
    });

    await pagina.setContent(`
      <input id="NI"><button id="ir"></button>
      <br-alert-messages></br-alert-messages><main>Certidão de Pessoa Jurídica</main>
      <script>
        document.getElementById('ir').onclick = () => {
          setTimeout(() => {
            document.querySelector('br-alert-messages').textContent =
              'Não foi possível concluir a ação. Por favor, tente novamente dentro de alguns minutos. 023';
          }, 300);
        };
      </script>`);

    const inicio = Date.now();
    const resultado = await receita.executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      esperarSeletor,
      dormir: async () => {},
    });
    const decorrido = Date.now() - inicio;

    assert.equal(resultado.situacao, 'indisponivel');
    assert.ok(decorrido < 15_000, `esperou ${decorrido}ms — deveria sair assim que o alerta aparece`);
  });

  test('a retentativa avisa o que está fazendo', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const avisos = [];
    const receita = receitaFormulario({
      id: 'fixture',
      nome: 'Portal de teste',
      url: 'about:blank',
      tentativasPortal: 2,
      sinaisResultado: ['#saida'],
      seletores: { campoDocumento: ['#NI'], botaoEnviar: ['#ir'], alvoResultado: ['#saida'] },
    });

    await pagina.setContent(`
      <input id="NI"><button id="ir"></button>
      <div id="saida">Sistema indisponível</div>`);

    await receita.executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      esperarSeletor,
      dormir: async () => {},
      registrar: (m) => avisos.push(m),
    });

    assert.equal(avisos.length, 1, 'avisa antes de esperar, não depois de terminar');
    assert.match(avisos[0], /tentativa 1\/2/);
  });
});

describe('certidão já existente', async () => {
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

  const receitaRFB = (tentativas = 1) =>
    receitaFormulario({
      id: 'fixture',
      nome: 'Portal de teste',
      url: 'about:blank',
      tentativasPortal: tentativas,
      sinaisResultado: ['#saida', '[role="dialog"]'],
      desviosAposEnvio: [
        {
          descricao: 'já existe válida — emitir nova',
          quando: ['[role="dialog"]:has-text("Certidão Válida")'],
          clicar: ['[role="dialog"] button:has-text("Emitir Nova Certidão")'],
        },
      ],
      seletores: {
        campoDocumento: ['#NI'],
        botaoEnviar: ['button:has-text("Emitir Certidão")'],
        botaoConsulta: ['button:has-text("Consultar Certidão")'],
        alvoResultado: ['#saida'],
      },
    });

  const executar = (receita) =>
    receita.executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      primeiroVisivel,
      esperarSeletor,
      dormir: async () => {},
    });

  /**
   * O portal avisa que já existe certidão válida e oferece consultá-la. Aceitar
   * a oferta devolveria um dado possivelmente de semanas atrás: débito que
   * entrou depois não estaria lá, e o monitoramento diria "tudo certo" sobre
   * quem acabou de virar devedor.
   */
  test('diante de certidão válida existente, emite uma nova', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    await pagina.setContent(`
      <input id="NI">
      <button onclick="document.getElementById('dlg').hidden=false">Emitir Certidão</button>
      <button onclick="mostrar('Positiva com efeitos de negativa — certidão ANTIGA')">Consultar Certidão</button>
      <div id="dlg" role="dialog" hidden>
        Certidão Válida Encontrada
        <button onclick="mostrar('Certidão Negativa de Débitos. Válida até 01/02/2027.')">Emitir Nova Certidão</button>
      </div>
      <div id="saida"></div>
      <script>
        function mostrar(txt) {
          document.getElementById('dlg').hidden = true;
          document.getElementById('saida').textContent = txt;
        }
      </script>`);

    const resultado = await executar(receitaRFB());

    assert.equal(resultado.situacao, 'negativa', 'leu a certidão nova, não a antiga');
    assert.doesNotMatch(resultado.detalhe, /ANTIGA/);
    assert.equal(resultado.validaAte, '01/02/2027');
  });

  test('emissão bloqueada cai na última válida, dizendo que o dado não é de agora', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    await pagina.setContent(`
      <input id="NI">
      <button onclick="mostrar('Não foi possível concluir a ação. Por favor, tente novamente dentro de alguns minutos. 023')">Emitir Certidão</button>
      <button onclick="mostrar('A1C4.C1EB.6886.3120 Positiva com efeitos de negativa 05/08/2026 01/02/2027 Válida')">Consultar Certidão</button>
      <div id="saida"></div>
      <script>
        function mostrar(txt) { document.getElementById('saida').textContent = txt; }
        // A recarga do último recurso perde o conteúdo montado por setContent,
        // então o teste o restaura para simular a página servida de verdade.
        window.addEventListener('beforeunload', () => {});
      </script>`);

    // Sem recarga real: a página fica como está entre as passadas.
    pagina.reload = async () => {};

    const resultado = await executar(receitaRFB(1));

    assert.equal(resultado.situacao, 'positiva_com_efeito_negativo');
    assert.equal(resultado.reaproveitada, true);
    assert.match(resultado.detalhe, /não é|Não foi possível emitir/i);
    assert.equal(resultado.numeroCertidao, 'A1C4.C1EB.6886.3120');
    assert.equal(resultado.validaAte, '01/02/2027');
  });
});

describe('ruído da página', async () => {
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

  /**
   * Foi o que aconteceu numa consulta real: o painel de cookies ficou aberto,
   * os containers de resultado ficaram vazios e a leitura caiu no corpo da
   * página. O relatório trouxe o menu do site como se fosse a resposta.
   */
  test('menu e painel de cookies não passam por resultado', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const receita = receitaFormulario({
      id: 'fixture',
      nome: 'Portal de teste',
      url: 'about:blank',
      tentativasPortal: 1,
      ruidos: [/configurações avançadas de cookies/i, /texto da pesquisa/i],
      seletores: {
        campoDocumento: ['#NI'],
        botaoEnviar: ['#ir'],
        alvoResultado: ['app-resultado', 'main'],
      },
    });

    await pagina.setContent(`
      <input id="NI"><button id="ir"></button>
      <app-resultado></app-resultado>
      <main>Funcionalidades do Sistema Ajuda Cookies Contraste Texto da pesquisa
            Configurações avançadas de cookies Última atualização: 30/07/2024</main>`);

    const resultado = await receita.executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      primeiroVisivel,
      esperarSeletor,
      dormir: async () => {},
    });

    assert.equal(resultado.situacao, 'erro');
    assert.match(resultado.detalhe, /não trouxe texto/);
    assert.doesNotMatch(resultado.detalhe, /Cookies/i, 'o menu não pode virar o desfecho');
  });

  test('a preparação só clica no que está visível e espera sumir', async (t) => {
    if (!navegador) return t.skip('Playwright/Chromium indisponível');

    const receita = receitaFormulario({
      id: 'fixture',
      nome: 'Portal de teste',
      url: 'about:blank',
      tentativasPortal: 1,
      preparacao: [
        {
          descricao: 'cookies',
          candidatos: ['#oculto button', 'button:has-text("Aceitar")'],
        },
      ],
      seletores: {
        campoDocumento: ['#NI'],
        botaoEnviar: ['#ir'],
        alvoResultado: ['#saida'],
      },
    });

    // O primeiro candidato existe no DOM mas está escondido: clicar nele não
    // tiraria nada da frente, e a barra visível continuaria cobrindo o form.
    await pagina.setContent(`
      <div id="oculto" style="display:none"><button>Aceitar</button></div>
      <div id="barra"><button onclick="this.parentElement.remove()">Aceitar</button></div>
      <input id="NI">
      <button id="ir" onclick="document.getElementById('saida').textContent='Certidão Negativa'"></button>
      <div id="saida"></div>`);

    const resultado = await receita.executar({
      pagina,
      cliente: { documento: '11222333000181', tipo: 'cnpj' },
      primeiroSeletorPresente,
      primeiroVisivel,
      esperarSeletor,
      dormir: async () => {},
    });

    assert.equal(await pagina.locator('#barra').count(), 0, 'a barra visível foi aceita');
    assert.equal(resultado.situacao, 'negativa');
  });
});
