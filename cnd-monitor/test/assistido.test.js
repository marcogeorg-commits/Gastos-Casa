import assert from 'node:assert/strict';
import test from 'node:test';

import { receitaFormulario } from '../src/receitas/index.js';
import { esperarSeletor, primeiroSeletorPresente, primeiroVisivel } from '../src/provedores/web.js';
import { temOperador } from '../src/provedores/assistido.js';

const PORTAL_FALSO = `
  <h1>Certidão Negativa de Débitos Trabalhistas</h1>
  <form id="f">
    <input id="doc" maxlength="18">
    <label>Digite os caracteres</label>
    <input type="text" id="idCampoResposta">
    <input type="submit" id="enviar" value="Emitir Certidão">
  </form>
  <div id="saida"></div>
  <script>
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const doc = document.getElementById('doc').value;
      const resposta = document.getElementById('idCampoResposta').value;
      // Só responde se o captcha foi preenchido — como um portal de verdade.
      document.getElementById('saida').textContent = resposta
        ? 'Certidão Negativa de Débitos. Documento ' + doc + '. Válida até 31/12/2026.'
        : '';
    });
  </script>`;

const receita = receitaFormulario({
  id: 'portal_falso',
  nome: 'Portal de Teste',
  urls: ['about:blank'],
  formatoDocumento: 'digitos',
  sinaisResultado: ['#saida'],
  seletores: {
    campoDocumento: ['#doc'],
    botaoEnviar: ['#enviar'],
    // `main` inclui o título da página, que já diz "Negativa" antes de
    // qualquer consulta — é assim no CNDT de verdade.
    alvoResultado: ['#saida', 'body'],
  },
});

async function comPagina(tarefa) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return null;
  }

  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  let navegador;
  try {
    navegador = await chromium.launch({
      args: ['--no-sandbox'],
      ...(executablePath ? { executablePath } : {}),
    });
  } catch {
    return null;
  }

  const pagina = await navegador.newPage();
  try {
    await pagina.setContent(PORTAL_FALSO);
    return await tarefa(pagina);
  } finally {
    await navegador.close();
  }
}

test('o modo assistido preenche o documento e espera a pessoa', async (t) => {
  const registrado = [];

  const saida = await comPagina(async (pagina) => {
    // O "humano": resolve o captcha e envia, meio segundo depois.
    setTimeout(async () => {
      await pagina.fill('#idCampoResposta', 'AB12').catch(() => {});
      await pagina.click('#enviar').catch(() => {});
    }, 500);

    return receita.executarAssistido({
      pagina,
      cliente: { nome: 'Alfa', documento: '11222333000181' },
      primeiroSeletorPresente,
      primeiroVisivel,
      esperarSeletor,
      esperaHumano: 15_000,
      registrar: (m) => registrado.push(m),
    });
  });

  if (saida === null) return t.skip('Playwright/Chromium indisponível');

  assert.equal(saida.situacao, 'negativa');
  assert.match(saida.detalhe, /11222333000181/, 'o documento tem de ter sido digitado pela máquina');
  assert.equal(saida.validaAte, '31/12/2026');

  // A pessoa precisa ser avisada do que fazer, e onde.
  assert.match(registrado.join(' '), /captcha/i);
  assert.match(registrado.join(' '), /Alfa/);
});

test('o modo assistido devolve conferência manual se ninguém agir', async (t) => {
  const saida = await comPagina(async (pagina) =>
    receita.executarAssistido({
      pagina,
      cliente: { nome: 'Beta', documento: '11222333000181' },
      primeiroSeletorPresente,
      primeiroVisivel,
      esperarSeletor,
      esperaHumano: 4000, // ninguém resolve
      registrar: () => {},
    }),
  );

  if (saida === null) return t.skip('Playwright/Chromium indisponível');

  // Silêncio não pode virar "negativa": ninguém consultou nada.
  assert.equal(saida.situacao, 'manual');
  assert.match(saida.detalhe, /nenhuma resposta reconhecível/);
});

test('sem janela e sem operador, o assistido recusa em vez de travar', () => {
  assert.equal(temOperador({ CI: 'true' }), false);
  assert.equal(temOperador({ GITHUB_ACTIONS: '1' }), false);

  if (process.platform === 'linux') {
    assert.equal(temOperador({}), false, 'sem DISPLAY não há janela');
    assert.equal(temOperador({ DISPLAY: ':0' }), true);
  }
});

test('o título da página não pode ser lido como resultado', async (t) => {
  // O CNDT se chama "Certidão Negativa de Débitos Trabalhistas": a palavra
  // "negativa" está na tela antes de qualquer consulta. Aceitá-la seria dar
  // por negativa uma certidão que ninguém emitiu — a pior falha possível aqui.
  const saida = await comPagina(async (pagina) =>
    receita.executarAssistido({
      pagina,
      cliente: { nome: 'Gama', documento: '11222333000181' },
      primeiroSeletorPresente,
      primeiroVisivel,
      esperarSeletor,
      esperaHumano: 4000, // ninguém resolve o captcha
      registrar: () => {},
    }),
  );

  if (saida === null) return t.skip('Playwright/Chromium indisponível');
  assert.equal(saida.situacao, 'manual', 'o título não pode virar "negativa"');
});

test('consultas assistidas nunca abrem duas janelas ao mesmo tempo', async () => {
  const { consultar } = await import('../src/provedores/assistido.js');

  // Sem operador, cada chamada devolve "manual" na hora — o que interessa é
  // que a fila as serialize em vez de dispará-las juntas.
  const ordem = [];
  const uma = (n) =>
    consultar({ cliente: { nome: `c${n}` }, idCertidao: 'cndt', env: { CI: 'true' } }).then((r) => {
      ordem.push(n);
      return r;
    });

  const resultados = await Promise.all([uma(1), uma(2), uma(3)]);
  assert.deepEqual(ordem, [1, 2, 3], 'a fila precisa preservar a ordem de chegada');
  for (const r of resultados) assert.equal(r.situacao, 'manual');
});
