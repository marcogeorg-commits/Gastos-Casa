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
    const links = [];
    const tagsCustomizadas = new Set();

    // "Botao" e o que se clica, nao a tag <button>. O gov.br entrega o caminho
    // de entrada como <a> estilizado e como <div role="button"> -- procurar so
    // por <button> devolvia "Botoes (0)" numa tela cheia de opcoes.
    const CLICAVEL =
      'button, input[type=submit], input[type=button], input[type=image], ' +
      '[role=button], [role=link], a[class*="btn" i], a[class*="button" i], [onclick]';

    const percorrer = (raiz) => {
      for (const el of raiz.querySelectorAll('*')) {
        if (el.tagName.includes('-')) tagsCustomizadas.add(el.tagName.toLowerCase());
        if (el.matches('input, select, textarea') && el.type !== 'hidden') {
          campos.push(descrever(el));
        }
        if (el.matches(CLICAVEL)) botoes.push(descrever(el));
        // Os links vao inteiros, com destino: num portal que redireciona para o
        // SSO, o href diz para onde a entrada leva mesmo quando o texto nao diz.
        if (el.matches('a[href]')) {
          links.push({ texto: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null, href: el.getAttribute('href') });
        }
        if (el.shadowRoot) percorrer(el.shadowRoot);
      }
    };
    percorrer(document);

    return {
      titulo: document.title,
      campos,
      botoes,
      links,
      tagsCustomizadas: [...tagsCustomizadas],
      iframes: [...document.querySelectorAll('iframe')].map((el) => el.src),
      // Fallback de diagnóstico: se nada foi encontrado, o texto da página diz
      // se caiu numa tela de erro, de manutenção ou de login.
      textoVisivel: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500),
      html: document.documentElement.outerHTML.length,
    };
  });
}
