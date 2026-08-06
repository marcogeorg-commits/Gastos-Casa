import test from 'node:test';
import assert from 'node:assert/strict';

import { escreverDocumento } from '../src/receitas/index.js';

/**
 * Campo com máscara, como o do portal da Receita.
 *
 * A máscara só reage a digitação: monta a pontuação tecla a tecla e ignora
 * valor colado de uma vez. É o comportamento que `fill()` não provoca -- e foi
 * por isso que o portal recebeu CNPJ vazio e respondeu "não foi possível
 * concluir a ação para o contribuinte informado. 023", que a rotina leu como
 * portal fora do ar.
 */
const PAGINA_COM_MASCARA = `
  <input id="doc">
  <script>
    const campo = document.getElementById('doc');
    let digitos = '';
    campo.addEventListener('keydown', (e) => {
      if (e.key.length === 1) {
        if (/[0-9]/.test(e.key) && digitos.length < 14) digitos += e.key;
        e.preventDefault();
        campo.value = digitos
          .replace(/^(\\d{2})(\\d)/, '$1.$2')
          .replace(/^(\\d{2})\\.(\\d{3})(\\d)/, '$1.$2.$3')
          .replace(/\\.(\\d{3})(\\d)/, '.$1/$2')
          .replace(/(\\d{4})(\\d)/, '$1-$2');
      }
    });
    // O que fill() faz: grava direto. A máscara nem fica sabendo.
    Object.defineProperty(campo, 'limparParaTeste', { value: () => { digitos = ''; } });
  </script>`;

async function comNavegador(t, corpo) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return t.skip('Playwright indisponível');
  }

  let navegador;
  try {
    navegador = await chromium.launch({
      args: ['--no-sandbox'],
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
  } catch {
    return t.skip('Chromium indisponível');
  }

  try {
    await corpo(navegador);
  } finally {
    await navegador.close();
  }
}

test('digitar atravessa a máscara; gravar de uma vez, não', async (t) => {
  await comNavegador(t, async (navegador) => {
    const pagina = await navegador.newPage();
    await pagina.setContent(PAGINA_COM_MASCARA);

    // Como era antes: o valor entra, mas a máscara não processa nada.
    await pagina.fill('#doc', '42160865000165');
    await pagina.evaluate(() => document.getElementById('doc').dispatchEvent(new Event('input')));
    await pagina.evaluate(() => document.getElementById('doc').limparParaTeste());

    const r = await escreverDocumento(pagina, '#doc', '42160865000165', '42160865000165');

    assert.equal(r.ok, true, `o campo ficou com "${r.encontrado}"`);
    // A máscara pôs a pontuação sozinha, que é o que ela faz para uma pessoa.
    assert.equal(await pagina.inputValue('#doc'), '42.160.865/0001-65');
  });
});

test('valor já formatado também chega inteiro, pela segunda tentativa', async (t) => {
  await comNavegador(t, async (navegador) => {
    const pagina = await navegador.newPage();
    await pagina.setContent(PAGINA_COM_MASCARA);

    // Mandar formatado faz a máscara receber separadores que ela mesma insere.
    // A conferência pega isso e reescreve só com dígitos.
    const r = await escreverDocumento(pagina, '#doc', '42.160.865/0001-65', '42160865000165');

    assert.equal(r.ok, true, `o campo ficou com "${r.encontrado}"`);
    assert.equal(await pagina.inputValue('#doc'), '42.160.865/0001-65');
  });
});

test('campo que recusa a digitação vira erro, não "portal indisponível"', async (t) => {
  await comNavegador(t, async (navegador) => {
    const pagina = await navegador.newPage();
    await pagina.setContent('<input id="doc" maxlength="4">');

    const r = await escreverDocumento(pagina, '#doc', '42160865000165', '42160865000165');

    // Enviar assim rendia o erro 023 do portal -- lido como indisponibilidade,
    // com três tentativas esperando um portal que não tinha problema nenhum.
    assert.equal(r.ok, false);
    assert.equal(r.encontrado, '4216');
  });
});
