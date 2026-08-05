/**
 * Receitas de automação — o "onde clicar" de cada portal, separado do "como
 * navegar" (que fica em `src/provedores/web.js`).
 *
 * Os seletores são listas de candidatos, tentados em ordem: portais públicos
 * mudam de layout sem aviso, e um candidato a mais é mais barato que uma
 * rodada perdida. Se nenhum casar, a consulta volta como `erro` dizendo qual
 * campo faltou — nunca como um resultado adivinhado.
 *
 * >>> Os seletores abaixo NÃO foram verificados contra os portais em produção.
 * >>> Rode `npm run calibrar -- <certidao>` de uma máquina com acesso aos sites
 * >>> para confirmá-los antes de confiar no resultado.
 */

import { formatar } from '../documentos.js';
import { interpretarTexto } from '../situacao.js';

const REGEX_VALIDADE = /v[áa]lida?\s+at[ée]\s+(\d{2}\/\d{2}\/\d{4})/i;
const REGEX_CONTROLE = /c[óo]digo\s+de\s+controle[:\s]+([A-Z0-9.\-]{6,})/i;

/**
 * Runner comum: abre o formulário, informa o documento, envia e lê o resultado.
 * Todo portal de certidão pública segue essa mesma forma.
 */
export function receitaFormulario(config) {
  const urlsPadrao = config.urls ?? (config.url ? [config.url] : []);

  return {
    id: config.id,
    nome: config.nome,
    url: urlsPadrao[0] ?? Object.values(config.urlsPorTipo ?? {})[0],
    urls: urlsPadrao,
    urlsPorTipo: config.urlsPorTipo,
    seletores: config.seletores,
    impedimento: config.impedimento,

    /** URLs candidatas para este cliente — o portal pode ter rota por tipo. */
    urlsPara(cliente) {
      const porTipo = config.urlsPorTipo?.[cliente?.tipo];
      return porTipo ? [porTipo, ...urlsPadrao] : urlsPadrao;
    },

    async executar({ pagina, cliente, primeiroSeletorPresente, esperarSeletor }) {
      // Sem `esperarSeletor` (chamada direta em teste) cai na sondagem simples.
      const esperar = esperarSeletor ?? primeiroSeletorPresente;
      const { campoDocumento, campoNascimento, botaoEnviar, alvoResultado } = config.seletores;

      // Barras de cookie e modais de aviso cobrem o formulário e engolem o
      // clique. Cada passo é opcional: se não estiver na tela, segue adiante.
      for (const passo of config.preparacao ?? []) {
        const alvo = await primeiroSeletorPresente(pagina, passo.candidatos);
        if (alvo) await pagina.click(alvo, { timeout: 5000 }).catch(() => {});
      }

      const campo = await esperar(pagina, campoDocumento);
      if (!campo) {
        return {
          situacao: 'erro',
          detalhe: `Campo do documento não encontrado. Rode "npm run calibrar -- ${config.id}" e atualize os seletores.`,
        };
      }

      const valor =
        config.formatoDocumento === 'formatado'
          ? formatar(cliente.documento)
          : cliente.documento;
      await pagina.fill(campo, valor);

      // A emissão para pessoa física costuma pedir a data de nascimento. Se o
      // portal pede e o cadastro não tem, é conferência manual — não se chuta.
      const nascimento = await primeiroSeletorPresente(pagina, campoNascimento ?? []);
      if (nascimento) {
        if (!cliente.dataNascimento) {
          return {
            situacao: 'manual',
            detalhe:
              'O portal pede a data de nascimento e ela não está no cadastro. Acrescente "dataNascimento" ao cliente em clientes.json.',
          };
        }
        await pagina.fill(nascimento, cliente.dataNascimento);
      }

      const botao = await esperar(pagina, botaoEnviar);
      if (!botao) {
        return {
          situacao: 'erro',
          detalhe: `Botão de envio não encontrado. Rode "npm run calibrar -- ${config.id}".`,
        };
      }

      await pagina.click(botao);

      // Num SPA nao ha navegacao: o sinal confiavel de que a consulta terminou
      // e a rota mudar para a tela de resultado.
      if (config.urlResultado) {
        await pagina.waitForURL(config.urlResultado, { timeout: 45_000 }).catch(() => {});
      }
      await pagina.waitForLoadState('networkidle').catch(() => {});

      const alvo = await esperar(pagina, alvoResultado ?? []);
      const texto = alvo ? await pagina.textContent(alvo) : await pagina.textContent('body');

      const situacao = interpretarTexto(texto);
      if (!situacao) {
        return {
          situacao: 'erro',
          detalhe: `Resposta não reconhecida: "${String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 180)}"`,
        };
      }

      return {
        situacao,
        detalhe: String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
        numeroCertidao: texto?.match(REGEX_CONTROLE)?.[1] ?? null,
        validaAte: texto?.match(REGEX_VALIDADE)?.[1] ?? null,
      };
    },
  };
}

/**
 * Portal de certidões da Receita: SPA Angular com rota em hash por tipo de
 * sujeito. Além de CNPJ e CPF existem `#/home/cib` (imóveis rurais) e
 * `#/home/cno` (obra de construção civil) — o cadastro ainda não modela esses
 * dois, porque usam identificador próprio, não CPF/CNPJ.
 */
const PORTAL_RFB = 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home';

export const RECEITAS = {
  rfb_pgfn: receitaFormulario({
    id: 'rfb_pgfn',
    nome: 'CND Federal (RFB/PGFN)',
    urlsPorTipo: {
      cnpj: `${PORTAL_RFB}/cnpj`,
      cpf: `${PORTAL_RFB}/cpf`,
    },
    urls: [PORTAL_RFB],
    formatoDocumento: 'formatado',
    // Confirmado no portal: a emissão leva a #/home/<tipo>/resultado.
    urlResultado: /#\/home\/(cnpj|cpf|cib|cno)\/resultado/,
    preparacao: [
      { descricao: 'aceitar cookies', candidatos: ['br-cookie-bar button:has-text("Aceitar")'] },
      { descricao: 'fechar aviso de mudança de NI', candidatos: ['modal-mudanca-ni button'] },
    ],
    seletores: {
      // Calibrado no portal: o campo tem id gerado a cada render
      // (#id3f7317eeae4b2c), então o id não serve de âncora. O placeholder é o
      // que identifica. `input[type=text]` está fora de propósito: a busca do
      // topo (#searchbox) também é text e vem antes no DOM — casaria primeiro e
      // o CNPJ iria parar no campo de busca do site.
      campoDocumento: [
        'input[placeholder="Informe o CNPJ"]',
        'input[placeholder="Informe o CPF"]',
        'br-input input:not(#searchbox)',
        'app-coleta-parametros-pj input[type="text"]',
      ],
      campoNascimento: [
        'input[placeholder*="nascimento" i]',
        'input[formcontrolname="dataNascimento"]',
      ],
      // Os botões não têm id; o texto é a única âncora estável. "Emitir" gera a
      // certidão do momento, que é o que a rotina precisa.
      botaoEnviar: [
        'button:has-text("Emitir Certidão")',
        'button:has-text("Consultar Certidão")',
      ],
      alvoResultado: ['app-resultado', 'main', 'body'],
    },
  }),

  cndt: receitaFormulario({
    id: 'cndt',
    nome: 'CNDT (TST)',
    urls: ['https://cndt-certidao.tst.jus.br/inicio.faces', 'https://cndt-certidao.tst.jus.br/'],
    formatoDocumento: 'formatado',
    seletores: {
      campoDocumento: ['#gerarCertidaoForm\\:cpfCnpj', 'input[name*="cpfCnpj"]'],
      botaoEnviar: ['#gerarCertidaoForm\\:btnEmitirCertidao', 'button[type="submit"]'],
      alvoResultado: ['.certidao', 'main', 'body'],
    },
  }),

  fgts_crf: receitaFormulario({
    id: 'fgts_crf',
    nome: 'CRF do FGTS (Caixa)',
    urls: ['https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf'],
    // A própria página instrui: inscrição somente números, UF em branco.
    formatoDocumento: 'digitos',
    seletores: {
      campoDocumento: ['#mainForm\\:txtInscricao1', 'input[name*="txtInscricao"]'],
      botaoEnviar: ['#mainForm\\:btnConsultar', 'input[type="submit"]'],
      alvoResultado: ['#mainForm', 'main', 'body'],
    },
  }),

  sefaz_sc: receitaFormulario({
    id: 'sefaz_sc',
    nome: 'CND Estadual SC (SEF/SC)',
    urls: ['https://sat.sef.sc.gov.br/tax.NET/Sat.CtaCte.Web/SolicitacaoCnd.aspx'],
    formatoDocumento: 'digitos',
    seletores: {
      campoDocumento: ['#txtCnpj', 'input[name*="Cnpj"]', 'input[type="text"]'],
      botaoEnviar: ['#btnSolicitar', 'input[type="submit"]'],
      alvoResultado: ['#divResultado', 'main', 'body'],
    },
  }),
};

export const IDS_RECEITAS = Object.keys(RECEITAS);
