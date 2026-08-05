/**
 * Catalogo das certidoes monitoradas.
 *
 * `provedores` lista quem sabe consultar aquela certidao. A ordem nao importa:
 * a escolha vem da configuracao (config.provedores[certidao] ou provedorPadrao).
 *
 * `apenasManual: true` marca certidoes que hoje nao tem API acessivel a empresa
 * privada -- o executor gera um item de acao no relatorio em vez de consultar.
 */

export const CATALOGO = {
  rfb_pgfn: {
    nome: 'CND Federal',
    orgao: 'Receita Federal / PGFN',
    descricao:
      'Certidão de Débitos relativos a Créditos Tributários Federais e à Dívida Ativa da União.',
    aceita: ['cnpj', 'cpf'],
    validadeDias: 180,
    provedores: ['serpro', 'infosimples', 'web', 'mock'],
    urlManual: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj',
  },

  cadin_federal: {
    nome: 'CADIN Federal',
    orgao: 'PGFN / Receita Federal (SISBACEN)',
    descricao:
      'Cadastro Informativo de Créditos não Quitados do Setor Público Federal.',
    aceita: ['cnpj', 'cpf'],
    validadeDias: null,
    provedores: ['mock'],
    apenasManual: true,
    exigeProcuracao: true,
    motivoManual:
      'Não existe API aberta a empresa privada. A API do Cadin-PGFN no catálogo ConectaGov é restrita a órgãos da administração pública federal. O caminho legítimo é o e-CAC ("Consulta de Inclusão no CADIN/SISBACEN") com certificado digital do escritório e procuração eletrônica do cliente.',
    urlManual: 'https://cav.receita.fazenda.gov.br/autenticacao/login',
  },

  fgts_crf: {
    nome: 'CRF do FGTS',
    orgao: 'Caixa Econômica Federal',
    descricao: 'Certificado de Regularidade do FGTS.',
    aceita: ['cnpj', 'cpf'],
    validadeDias: 30,
    provedores: ['infosimples', 'web', 'mock'],
    urlManual: 'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf',
  },

  cndt: {
    nome: 'CNDT Trabalhista',
    orgao: 'Tribunal Superior do Trabalho',
    descricao: 'Certidão Negativa de Débitos Trabalhistas.',
    aceita: ['cnpj', 'cpf'],
    validadeDias: 180,
    provedores: ['infosimples', 'web', 'mock'],
    urlManual: 'https://cndt-certidao.tst.jus.br/inicio.faces',
  },

  sefaz_sc: {
    nome: 'CND Estadual SC',
    orgao: 'SEF/SC',
    descricao: 'Certidão Negativa de Débitos Estaduais de Santa Catarina.',
    aceita: ['cnpj'],
    validadeDias: 90,
    provedores: ['infosimples', 'web', 'mock'],
    urlManual: 'https://sat.sef.sc.gov.br/tax.NET/Sat.CtaCte.Web/SolicitacaoCnd.aspx',
  },

  municipal: {
    nome: 'CND Municipal',
    orgao: 'Prefeitura do município sede',
    descricao: 'Certidão Negativa de Tributos Municipais.',
    aceita: ['cnpj'],
    validadeDias: 90,
    provedores: ['infosimples', 'web', 'mock'],
    exigeMunicipio: true,
    urlManual: null,
  },
};

export const IDS_CERTIDOES = Object.keys(CATALOGO);

/**
 * Situacoes normalizadas. `pendencia: true` significa que o cliente precisa de
 * acao -- e o que ordena o relatorio.
 *
 * `status` usa a paleta reservada de estado (good/warning/serious/critical) e
 * anda sempre acompanhada de icone + rotulo: a cor nunca carrega o significado
 * sozinha.
 */
export const SITUACOES = {
  negativa: {
    rotulo: 'Negativa',
    curto: 'Negativa',
    icone: '✓',
    status: 'good',
    pendencia: false,
  },
  positiva_com_efeito_negativo: {
    rotulo: 'Positiva com efeito de negativa',
    curto: 'Efeito negativa',
    icone: '✓',
    status: 'good',
    pendencia: false,
  },
  positiva: {
    rotulo: 'Positiva (há débitos)',
    curto: 'Débitos',
    icone: '✕',
    status: 'critical',
    pendencia: true,
  },
  sem_registro: {
    rotulo: 'Sem registro no cadastro',
    curto: 'Nada consta',
    icone: '✓',
    status: 'good',
    pendencia: false,
  },
  // `manual` nao conta como pendencia: e uma limitacao estrutural da fonte (o
  // CADIN federal cai aqui para todo mundo), nao um problema do cliente. Fica
  // em sua propria secao do relatorio para nao afogar os debitos de verdade.
  manual: {
    rotulo: 'Exige consulta manual',
    curto: 'Manual',
    icone: '▲',
    status: 'warning',
    pendencia: false,
    manual: true,
  },
  nao_aplicavel: {
    rotulo: 'Não se aplica a este cliente',
    curto: 'n/a',
    icone: '–',
    status: 'neutro',
    pendencia: false,
  },
  erro: {
    rotulo: 'Falha na consulta',
    curto: 'Falha',
    icone: '▲',
    status: 'serious',
    pendencia: true,
  },
};

export function descreverSituacao(situacao) {
  return SITUACOES[situacao] ?? SITUACOES.erro;
}
