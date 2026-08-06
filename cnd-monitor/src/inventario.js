/**
 * Inventário dos controles de uma tela.
 *
 * Mora em módulo próprio porque serve a dois donos: a calibração, que sai
 * atrás de seletores de propósito, e o provedor do e-CAC, que precisa dizer o
 * que havia na tela quando a sessão não abriu. Deixá-lo dentro da calibração
 * obrigaria o provedor a importar quem já o importa -- ciclo.
 */

/**
 * Inventário dos controles interativos, atravessando shadow DOM.
 *
 * `document.querySelectorAll` não enxerga dentro de shadow roots; componentes do
 * design system do gov.br podem usá-los. Um campo invisível ao inventário mas
 * visível ao Playwright levaria a diagnóstico errado.
 */
export async function inventariar(pagina) {
  return pagina.evaluate(() => {
    const descrever = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      id: el.id || null,
      name: el.getAttribute('name'),
      formcontrolname: el.getAttribute('formcontrolname'),
      placeholder: el.getAttribute('placeholder'),
      aria: el.getAttribute('aria-label'),
      texto: (el.innerText || el.value || '').trim().slice(0, 60) || null,
      seletor: el.id
        ? `#${CSS.escape(el.id)}`
        : el.getAttribute('formcontrolname')
          ? `${el.tagName.toLowerCase()}[formcontrolname="${el.getAttribute('formcontrolname')}"]`
          : el.getAttribute('name')
            ? `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`
            : null,
    });

    const campos = [];
    const botoes = [];
    const tagsCustomizadas = new Set();

    const percorrer = (raiz) => {
      for (const el of raiz.querySelectorAll('*')) {
        if (el.tagName.includes('-')) tagsCustomizadas.add(el.tagName.toLowerCase());
        if (el.matches('input, select, textarea') && el.type !== 'hidden') {
          campos.push(descrever(el));
        }
        if (el.matches('button, input[type=submit], a[role=button]')) botoes.push(descrever(el));
        if (el.shadowRoot) percorrer(el.shadowRoot);
      }
    };
    percorrer(document);

    return {
      titulo: document.title,
      campos,
      botoes,
      tagsCustomizadas: [...tagsCustomizadas],
      iframes: [...document.querySelectorAll('iframe')].map((el) => el.src),
      // Fallback de diagnóstico: se nada foi encontrado, o texto da página diz
      // se caiu numa tela de erro, de manutenção ou de login.
      textoVisivel: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
      html: document.documentElement.outerHTML.length,
    };
  });
}
