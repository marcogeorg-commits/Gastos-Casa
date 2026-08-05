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
  const urls = config.urls ?? [config.url];

  return {
    id: config.id,
    nome: config.nome,
    url: urls[0],
    urls,
    seletores: config.seletores,
    impedimento: config.impedimento,

    async executar({ pagina, cliente, primeiroSeletorPresente }) {
      const { campoDocumento, botaoEnviar, alvoResultado } = config.seletores;

      const campo = await primeiroSeletorPresente(pagina, campoDocumento);
      if (!campo) {
        return {
          situacao: 'erro',
          detalhe: `Campo do documento não encontrado em ${urls[0]}. Rode "npm run calibrar -- ${config.id}" e atualize os seletores.`,
        };
      }

      const valor =
        config.formatoDocumento === 'formatado'
          ? formatar(cliente.documento)
          : cliente.documento;
      await pagina.fill(campo, valor);

      const botao = await primeiroSeletorPresente(pagina, botaoEnviar);
      if (!botao) {
        return {
          situacao: 'erro',
          detalhe: `Botão de envio não encontrado em ${urls[0]}. Rode "npm run calibrar -- ${config.id}".`,
        };
      }

      await Promise.all([
        pagina.waitForLoadState('networkidle').catch(() => {}),
        pagina.click(botao),
      ]);

      const alvo = await primeiroSeletorPresente(pagina, alvoResultado ?? []);
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

export const RECEITAS = {
  rfb_pgfn: receitaFormulario({
    id: 'rfb_pgfn',
    nome: 'CND Federal (RFB/PGFN)',
    // O caminho da emissão muda entre PJ e PF; a receita usa o de PJ e recusa
    // CPF, porque a emissão para pessoa física pede também a data de nascimento.
    urls: [
      'https://solucoes.receita.fazenda.gov.br/Servicos/certidaointernet/PJ/Emitir',
      'https://servicos.receitafederal.gov.br/servico/certidoes/',
    ],
    formatoDocumento: 'digitos',
    seletores: {
      campoDocumento: ['#NI', 'input[name="NI"]', '#txtCNPJ', 'input[name="cnpj"]'],
      botaoEnviar: ['#validar', 'input[type="submit"]', 'button[type="submit"]'],
      alvoResultado: ['#idResultado', '.certidao', 'main'],
    },
    impedimento: (cliente) =>
      cliente.tipo === 'cpf'
        ? 'A emissão para pessoa física exige a data de nascimento, que não está no cadastro. Consulte no portal ou use um provedor de API.'
        : null,
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
