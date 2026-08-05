/**
 * Receitas do e-CAC — consultas autenticadas com o certificado do cliente.
 *
 * O e-CAC é o único caminho legítimo para o CADIN federal por uma empresa
 * privada, e de quebra dá o Relatório de Situação Fiscal, que lista todas as
 * pendências — mais detalhado que a própria certidão.
 *
 * >>> Nenhum destes seletores foi verificado contra o portal: o ambiente onde
 * >>> foram escritos não alcança o e-CAC, e a tela exige certificado. Rode
 * >>> `npm run calibrar -- <certidao> --certificado <cliente>` de uma máquina
 * >>> com o certificado instalado antes de confiar no resultado.
 */

export const LOGIN_ECAC = 'https://cav.receita.fazenda.gov.br/autenticacao/login';

/** Origem para a qual o certificado do cliente deve ser apresentado. */
export const ORIGENS_CERTIFICADO = [
  'https://cav.receita.fazenda.gov.br',
  'https://certificado.sso.acesso.gov.br',
];

/**
 * Cada receita descreve: como chegar na tela, como saber que chegou, e de onde
 * ler a resposta. A navegação em si fica no provedor.
 */
export const RECEITAS_ECAC = {
  cadin_federal: {
    id: 'cadin_federal',
    nome: 'CADIN Federal (e-CAC)',
    // O serviço aparece no menu como "Consulta de Inclusão no CADIN/SISBACEN".
    caminhoServico: [
      'a:has-text("CADIN")',
      'a:has-text("Consulta de Inclusão no CADIN")',
      'a[href*="cadin" i]',
    ],
    sinaisResultado: ['#conteudo', 'main', '.corpo'],
    alvoResultado: ['#conteudo', 'main'],
    ruidos: [/menu principal/i, /fale conosco/i],
  },

  situacao_fiscal: {
    id: 'situacao_fiscal',
    nome: 'Relatório de Situação Fiscal (e-CAC)',
    caminhoServico: [
      'a:has-text("Situação Fiscal")',
      'a:has-text("Relatório de Situação Fiscal")',
      'a[href*="situacaofiscal" i]',
    ],
    sinaisResultado: ['#conteudo', 'main', '.corpo'],
    alvoResultado: ['#conteudo', 'main'],
    ruidos: [/menu principal/i, /fale conosco/i],
  },
};

export const IDS_ECAC = Object.keys(RECEITAS_ECAC);
