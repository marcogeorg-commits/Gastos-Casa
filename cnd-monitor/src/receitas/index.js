/**
 * Receitas de automação — o "onde clicar" de cada portal, separado do "como
 * navegar" (que fica em `src/provedores/web.js`).
 *
 * Os seletores são listas de candidatos, tentados em ordem: portais públicos
 * mudam de layout sem aviso, e um candidato a mais é mais barato que uma
 * rodada perdida. Se nenhum casar, a consulta volta como `erro` dizendo qual
 * campo faltou — nunca como um resultado adivinhado.
 *
 * >>> Só os da CND Federal foram calibrados contra o portal real. Os de FGTS,
 * >>> CNDT e SEFAZ/SC continuam sendo palpite: rode
 * >>> `npm run calibrar -- <certidao>` de uma máquina com acesso aos sites
 * >>> antes de confiar no resultado deles.
 */

import { formatar } from '../documentos.js';
import { interpretarTexto } from '../situacao.js';

const REGEX_VALIDADE = /v[áa]lida?\s+at[ée]\s+(\d{2}\/\d{2}\/\d{4})/i;
const REGEX_CONTROLE = /c[óo]digo\s+de\s+controle[:\s]+([A-Z0-9.\-]{6,})/i;
// Formato do código de controle da Receita: quatro grupos de 4, separados por
// ponto. Na tela de consulta ele vem numa tabela, sem o rótulo ao lado.
const REGEX_CONTROLE_RFB = /\b([0-9A-F]{4}\.[0-9A-F]{4}\.[0-9A-F]{4}\.[0-9A-F]{4})\b/;
const REGEX_DATA = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;

/**
 * Validade da certidao.
 *
 * Na tela de emissao vem escrito "válida até <data>". Na tela de consulta vem
 * numa tabela, junto com datas de emissao -- e ali a maior data e a validade,
 * porque emissao e sempre passado e validade sempre futuro.
 */
export function extrairValidade(texto) {
  const explicita = texto.match(REGEX_VALIDADE)?.[1];
  if (explicita) return explicita;

  const datas = [...texto.matchAll(REGEX_DATA)].map(([bruta, d, m, a]) => ({
    bruta,
    ordenavel: `${a}${m}${d}`,
  }));
  if (datas.length === 0) return null;

  return datas.sort((x, y) => y.ordenavel.localeCompare(x.ordenavel))[0].bruta;
}

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
    // Exposta porque o calibrador precisa percorrer os mesmos passos antes de
    // inventariar. Em execucao ela ja funcionava pelo closure, e foi por isso
    // que a ausencia aqui passou despercebida: o portal era atravessado, mas o
    // diagnostico continuava descrevendo a tela de entrada.
    preparacao: config.preparacao,

    /** URLs candidatas para este cliente — o portal pode ter rota por tipo. */
    urlsPara(cliente) {
      const porTipo = config.urlsPorTipo?.[cliente?.tipo];
      return porTipo ? [porTipo, ...urlsPadrao] : urlsPadrao;
    },

    async executar(argumentos) {
      const { pagina, dormir, registrar, env = {} } = argumentos;
      const avisar = registrar ?? (() => {});

      // O portal responde "tente novamente dentro de alguns minutos" (erro 023)
      // em falhas passageiras. Desistir na primeira faria uma empresa regular
      // aparecer como pendência só porque o sistema piscou.
      const tentativas = Number(env.WEB_TENTATIVAS_PORTAL ?? config.tentativasPortal ?? 3);
      const espera = Number(env.WEB_ESPERA_PORTAL ?? 30_000);
      const aguardar = dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

      let resultado;
      for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
        resultado = await umaTentativa(config, argumentos);

        if (resultado.situacao !== 'indisponivel' || tentativa === tentativas) break;

        // Minutos de silêncio parecem travamento. Dizer o que está havendo é o
        // que separa "esperando o portal" de "programa pendurado".
        avisar(
          `      ${config.nome}: portal indisponível (tentativa ${tentativa}/${tentativas}), aguardando ${Math.round(espera / 1000)}s`,
        );
        await aguardar(espera);
        await pagina.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }

      if (resultado.situacao !== 'indisponivel') return resultado;

      if (tentativas > 1) {
        resultado.detalhe = `${resultado.detalhe} (após ${tentativas} tentativas)`;
      }

      // Emissão bloqueada. Ler a última certidão válida é melhor que devolver
      // só "indisponível" -- desde que fique explícito que o dado não é de
      // agora, senão vira exatamente a mentira que se queria evitar.
      const anterior = await consultarUltimaValida(config, argumentos, avisar);
      return anterior ?? resultado;
    },
  };
}

/**
 * Ultimo recurso: le a certidao valida ja emitida, sem tentar emitir outra.
 *
 * Devolve `null` quando nao ha o que aproveitar, para o chamador manter o
 * "indisponivel" original.
 */
async function consultarUltimaValida(config, argumentos, avisar) {
  const seletores = config.seletores ?? {};
  // Aceita nos dois lugares: o botão é um seletor, mas ler só da raiz deixava o
  // recurso final silenciosamente desligado.
  const botaoConsulta = config.botaoConsulta ?? seletores.botaoConsulta;
  if (!botaoConsulta) return null;

  avisar(`      ${config.nome}: emissão bloqueada, lendo a última certidão válida`);
  await argumentos.pagina.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});

  const comConsulta = {
    ...config,
    desviosAposEnvio: [],
    seletores: { ...seletores, botaoEnviar: botaoConsulta },
  };
  const resultado = await umaTentativa(comConsulta, argumentos);

  if (resultado.situacao === 'erro' || resultado.situacao === 'indisponivel') return null;

  return {
    ...resultado,
    reaproveitada: true,
    detalhe:
      `Não foi possível emitir certidão nova; dado da última certidão válida${
        resultado.validaAte ? `, com validade até ${resultado.validaAte}` : ''
      }. ${resultado.detalhe}`,
  };
}

/**
 * Texto do desfecho, na ordem de prioridade dos candidatos.
 *
 * Um container existir nao significa que ele diga algo: no portal da Receita o
 * `app-resultado` fica vazio quando a resposta vem como alerta no topo da
 * pagina. Ler o primeiro que casa e aceitar string vazia produzia
 * "resposta nao reconhecida" com a mensagem bem visivel na tela.
 */
async function textoDoResultado(pagina, candidatos, esperar, ruidos = []) {
  const lista = candidatos ?? [];
  if (lista.length === 0) return '';

  // Da tempo de o SPA montar ao menos um dos alvos antes de varrer.
  await esperar(pagina, lista);

  for (const seletor of lista) {
    const alvo = pagina.locator(seletor).first();
    if ((await alvo.count()) === 0) continue;

    const texto = ((await alvo.textContent().catch(() => '')) ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!texto) continue;

    // Menu, busca e painel de cookies tem texto de sobra e nao dizem nada sobre
    // a certidao. Ler isso produzia "resposta nao reconhecida" com o conteudo
    // do site inteiro no lugar do desfecho.
    if (ruidos.some((padrao) => padrao.test(texto))) continue;

    return texto;
  }
  return '';
}

/**
 * Espera o desfecho: a rota mudar para a tela de resultado **ou** um dos sinais
 * ganhar texto.
 *
 * Esperar so pela rota custava 45s toda vez que o portal respondia com alerta
 * em vez de navegar -- que e justamente o caso de erro, o mais frequente numa
 * hora ruim. Tres tentativas assim viravam minutos de silencio.
 */
async function esperarDesfecho(pagina, config, tempoLimite = 45_000) {
  const sinais = config.sinaisResultado ?? [];
  if (!config.urlResultado && sinais.length === 0) return;

  await pagina
    .waitForFunction(
      ({ seletores, padraoUrl }) => {
        if (padraoUrl && new RegExp(padraoUrl).test(location.href)) return true;
        return seletores.some(
          (s) => (document.querySelector(s)?.textContent ?? '').trim().length > 0,
        );
      },
      { seletores: sinais, padraoUrl: config.urlResultado?.source ?? null },
      { timeout: tempoLimite },
    )
    .catch(() => {});
}

/** Uma passada pelo formulário: preenche, envia e lê o que voltou. */
async function umaTentativa(
  config,
  { pagina, cliente, primeiroSeletorPresente, primeiroVisivel, esperarSeletor },
) {
  // Sem `esperarSeletor` (chamada direta em teste) cai na sondagem simples.
  const esperar = esperarSeletor ?? primeiroSeletorPresente;
  // Sem `primeiroVisivel`, aproxima com o primeiro presente: pior, mas melhor
  // que estourar por causa de um argumento ausente.
  const visivel =
    primeiroVisivel ??
    (async (p, candidatos) => {
      const seletor = await primeiroSeletorPresente(p, candidatos);
      return seletor ? p.locator(seletor).first() : null;
    });
  const { campoDocumento, campoNascimento, botaoEnviar, alvoResultado } = config.seletores;

  // Barras de cookie e modais de aviso cobrem o formulário e engolem o
  // clique. Cada passo é opcional: se não estiver na tela, segue adiante.
  for (const passo of config.preparacao ?? []) {
    // Só o que está visível: componentes de aviso ficam no DOM o tempo todo,
    // escondidos, e clicar no invisível não tira nada da frente.
    const alvo = await visivel(pagina, passo.candidatos);
    if (!alvo) continue;

    await alvo.click({ timeout: 5000 }).catch(() => {});
    // Esperar sumir evita seguir com o diálogo ainda cobrindo o formulário.
    await alvo.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  const campo = await esperar(pagina, campoDocumento);
  if (!campo) {
    return {
      situacao: 'erro',
      detalhe: `Campo do documento não encontrado. Rode "npm run calibrar -- ${config.id}" e atualize os seletores.`,
    };
  }

  const valor =
    config.formatoDocumento === 'formatado' ? formatar(cliente.documento) : cliente.documento;
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
  await esperarDesfecho(pagina, config);

  // Depois de enviar, o portal pode abrir um diálogo em vez de responder. Na
  // Receita ele avisa que já existe certidão válida e oferece consultá-la ou
  // emitir outra. A rotina emite outra: a certidão guardada pode ser de semanas
  // atrás, e débito que entrou depois não apareceria nela — um monitoramento
  // que repete o dado velho diz "tudo certo" sobre quem acabou de mudar.
  for (const desvio of config.desviosAposEnvio ?? []) {
    const gatilho = await visivel(pagina, desvio.quando);
    if (!gatilho) continue;

    const acao = await visivel(pagina, desvio.clicar);
    if (!acao) continue;

    await acao.click({ timeout: 5000 }).catch(() => {});
    await esperarDesfecho(pagina, config);
  }

  await pagina.waitForLoadState('networkidle').catch(() => {});

  const limpo = await textoDoResultado(pagina, alvoResultado, esperar, config.ruidos);
  if (!limpo) {
    return {
      situacao: 'erro',
      detalhe: `A página não trouxe texto de resultado. Rode "npm run calibrar -- ${config.id}".`,
    };
  }

  const situacao = interpretarTexto(limpo);
  if (!situacao) {
    return { situacao: 'erro', detalhe: `Resposta não reconhecida: "${limpo.slice(0, 180)}"` };
  }

  return {
    situacao,
    detalhe: limpo.slice(0, 240),
    numeroCertidao: limpo.match(REGEX_CONTROLE)?.[1] ?? limpo.match(REGEX_CONTROLE_RFB)?.[1] ?? null,
    validaAte: extrairValidade(limpo),
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
    // Só os específicos: `main` e `body` sempre têm texto e encerrariam a
    // espera antes de a resposta chegar.
    sinaisResultado: [
      'br-alert-messages',
      '.br-message',
      'app-resultado',
      '[role="dialog"]',
      '.br-modal',
      'table',
    ],
    desviosAposEnvio: [
      {
        descricao: 'já existe certidão válida — emitir uma nova mesmo assim',
        quando: [
          '[role="dialog"]:has-text("Certidão Válida")',
          '.br-modal:has-text("Certidão Válida")',
        ],
        clicar: [
          '[role="dialog"] button:has-text("Emitir Nova Certidão")',
          'button:has-text("Emitir Nova Certidão")',
        ],
      },
    ],
    preparacao: [
      {
        descricao: 'aceitar cookies',
        // O botão não tem id e o container varia entre a barra e o painel de
        // configurações avançadas; o texto é a âncora que sobra.
        candidatos: [
          'br-cookie-bar button:has-text("Aceitar")',
          'button:has-text("Aceitar todos")',
          'button:has-text("Aceitar Todos")',
          'button:has-text("Aceitar")',
        ],
      },
      { descricao: 'fechar aviso de mudança de NI', candidatos: ['modal-mudanca-ni button'] },
    ],
    // `body` fica de fora de propósito: sem ele, container vazio vira erro
    // explícito, e não uma varredura do site inteiro apresentada como resposta.
    ruidos: [/configura[çc][õo]es avan[çc]adas de cookies/i, /texto da pesquisa/i],
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
      botaoEnviar: ['button:has-text("Emitir Certidão")'],
      // Último recurso quando a emissão não passa: lê a última certidão válida
      // já emitida, deixando claro no relatório que o dado não é do momento.
      botaoConsulta: ['button:has-text("Consultar Certidão")'],
      // O portal responde de dois jeitos: resultado dentro do conteúdo, ou
      // alerta no topo da página (é onde aparece o erro 023). O alerta vem
      // primeiro porque, quando existe, ele é o desfecho.
      alvoResultado: ['br-alert-messages', '.br-message', 'app-resultado', 'table', 'main'],
    },
  }),

  /**
   * CNDT — calibrado no portal real.
   *
   * **Tem captcha próprio** — campo `#idCampoResposta` mais um botão "Ouvir",
   * o par clássico de desafio acessível. A primeira calibração disse "sem
   * captcha" porque inventariou a tela de entrada, que só tem dois botões; o
   * desafio está no formulário, uma tela adiante.
   *
   * A entrada (`inicio.faces`) não é o formulário: tem só dois botões, "Emitir
   * Certidão" e "Validar Certidão". O campo do documento está na tela seguinte,
   * e é por isso que a primeira calibração não achou candidato nenhum -- ela
   * descrevia a porta, não a sala.
   *
   * Os `name` do portal são gerados pelo JSF (`j_id_jsp_992698495_2:...`) e
   * mudam a cada implantação: ancorar neles quebraria na próxima. O texto do
   * botão é o que permanece.
   */
  cndt: receitaFormulario({
    id: 'cndt',
    nome: 'CNDT (TST)',
    urls: ['https://cndt-certidao.tst.jus.br/inicio.faces', 'https://cndt-certidao.tst.jus.br/'],
    formatoDocumento: 'formatado',
    preparacao: [
      {
        nome: 'Emitir Certidão',
        candidatos: [
          'input[value="Emitir Certidão"]',
          'input[value*="Emitir" i]',
          'a:has-text("Emitir Certidão")',
          'button:has-text("Emitir Certidão")',
        ],
      },
    ],
    seletores: {
      // Ids explicitos do portal, confirmados na calibracao. Os "j_id_jsp_*"
      // que aparecem ao lado sao gerados e nao servem de ancora.
      campoDocumento: [
        '#gerarCertidaoForm\\:cpfCnpj',
        'input[name*="cpfCnpj" i]',
        'input[maxlength="18"]',
      ],
      // NUNCA `btnEmitirCertidaoEEnviarPorEmail`: existe no mesmo formulario e
      // dispara envio de e-mail em nome do escritorio para o endereco digitado
      // em `#campoEmail`. Emitir e mandar e-mail sao coisas diferentes.
      botaoEnviar: [
        '#gerarCertidaoForm\\:btnEmitirCertidao',
        'input[value="Emitir Certidão"]',
      ],
      alvoResultado: ['.certidao', 'form', 'main'],
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

  /**
   * SEF/SC — calibrado no portal real.
   *
   * A tela tem **captcha de imagem visível** ("Digite o texto"), então o
   * provedor `web` devolve conferência manual e nem tenta: não há o que
   * automatizar sem um humano lendo a figura. Os seletores ficam corretos
   * mesmo assim, para o dia em que a consulta vier por API.
   */
  sefaz_sc: receitaFormulario({
    id: 'sefaz_sc',
    nome: 'CND Estadual SC (SEF/SC)',
    urls: ['https://sat.sef.sc.gov.br/tax.NET/Sat.CtaCte.Web/SolicitacaoCnd.aspx'],
    formatoDocumento: 'digitos',
    // `input[type=text]` está fora: a busca do combo (#s2id_autogen1) vem antes
    // no DOM e receberia o CNPJ.
    ruidos: [/digite o texto/i],
    seletores: {
      campoDocumento: [
        '#Body_Main_Main_sepBusca_idnCnd_MaskedField',
        'input[id*="idnCnd_MaskedField"]',
      ],
      campoTipoDocumento: ['#Body_Main_Main_sepBusca_idnCnd_IdentificationTypeField'],
      campoCaptcha: ['input[placeholder="Digite o texto"]', 'input[name*="ctl18"]'],
      botaoEnviar: ['#Body_Main_Main_sepBusca_btnBuscar', 'a:has-text("Buscar")', 'input[type="submit"]'],
      alvoResultado: ['#Body_Main_Main_ctnResultado', 'main'],
    },
  }),
};

export const IDS_RECEITAS = Object.keys(RECEITAS);
