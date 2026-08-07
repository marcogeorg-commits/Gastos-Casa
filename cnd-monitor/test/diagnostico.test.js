import test from 'node:test';
import assert from 'node:assert/strict';

import { criarDiario, vaiParaODiario } from '../src/diagnostico.js';

/**
 * O corpo da resposta de API é o ponto do diagnóstico.
 *
 * O "023" da Receita aparece na tela como uma frase; quem a produziu foi uma
 * resposta que ninguém estava lendo. Sem registrá-la, discutir a causa é
 * adivinhação — e foi o que aconteceu por horas.
 */
test('registra chamada de serviço e descarta recurso estático', () => {
  assert.equal(vaiParaODiario('https://servicos.receitafederal.gov.br/api/certidao', 'xhr'), true);
  assert.equal(vaiParaODiario('https://portal.gov.br/servico/emitir', 'fetch'), true);
  assert.equal(vaiParaODiario('https://portal.gov.br/pagina', 'document'), true);

  // Sem o filtro, o arquivo vira um despejo de centenas de recursos e a
  // resposta que explica o erro se perde no meio.
  assert.equal(vaiParaODiario('https://portal.gov.br/logo.png', 'image'), false);
  assert.equal(vaiParaODiario('https://portal.gov.br/app.js', 'script'), false);
  assert.equal(vaiParaODiario('https://portal.gov.br/estilo.css', 'stylesheet'), false);
  assert.equal(vaiParaODiario('https://portal.gov.br/fonte.woff2', 'other'), false);

  // hCaptcha conversa o tempo todo e nada disso diz sobre a certidão.
  assert.equal(vaiParaODiario('https://newassets.hcaptcha.com/captcha/v1/x', 'xhr'), false);
});

test('o diário guarda a ordem e o relógio de cada passo', () => {
  let agora = 0;
  const d = criarDiario(() => new Date(agora));

  d.escrever('abriu o portal');
  agora = 2500;
  d.secao('Enviando');
  agora = 4000;
  d.escrever('clicou');

  const linhas = d.texto().split('\n').filter(Boolean);

  // A ordem é o que permite ligar causa e efeito: sem ela, "deu erro" e "cliquei"
  // ficam soltos e não dá para saber qual veio antes.
  assert.match(linhas[0], /0s\] abriu o portal/);
  assert.match(linhas[1], /2\.5s\] ── Enviando/);
  assert.match(linhas[2], /4s\] clicou/);
});

/**
 * O portal conta uma coisa na tela e outra na resposta da API.
 *
 *   tela:  "Não foi possível concluir a ação para o contribuinte informado.
 *           Por favor, tente novamente dentro de alguns minutos. 023"
 *   API:   {"statusValidacao":"CaptchaFalhaValidacao","codigo":"023"}
 *
 * A frase da tela levou a rotina a tratar como portal fora do ar e tentar de
 * novo três vezes — e levou horas de investigação pelo caminho errado.
 */
test('o "023" é captcha reprovado, não portal fora do ar', async () => {
  const { traduzirValidacao } = await import('../src/provedores/web.js');

  const r = traduzirValidacao({ statusValidacao: 'CaptchaFalhaValidacao', codigo: '023' });

  // "indisponivel" dispara três tentativas contra um portal que está de pé.
  assert.equal(r.situacao, 'manual');
  assert.match(r.detalhe, /captcha/i);
  assert.match(r.detalhe, /repetir n[aã]o/i, 'tem de dizer que insistir não resolve');

  // Outra recusa qualquer também é nomeada, em vez de virar "indisponível" —
  // e documento inválido é `erro`, não `manual`: o defeito está no cadastro,
  // e mandar o operador consultar à mão não conserta o CNPJ errado.
  const outra = traduzirValidacao({ statusValidacao: 'DocumentoInvalido', codigo: '011' });
  assert.equal(outra.situacao, 'erro');
  assert.match(outra.detalhe, /DocumentoInvalido/);

  // Sem resposta de API, quem manda continua sendo a leitura da tela.
  assert.equal(traduzirValidacao(null), null);
  assert.equal(traduzirValidacao({}), null);
});

/**
 * A recomendação errada custa tanto quanto o diagnóstico errado.
 *
 * "Aguarde e tente novamente" diante de um captcha reprovado manda o operador
 * esperar por um portal que não tem problema nenhum — foi assim que a rotina
 * passou o dia tentando três vezes.
 */
test('cada recusa do portal leva ao desfecho que corresponde a ela', async () => {
  const { traduzirValidacao } = await import('../src/provedores/web.js');
  const desfecho = (statusValidacao) => traduzirValidacao({ statusValidacao, codigo: 'x' }).situacao;

  // Captcha: não adianta esperar, adianta uma pessoa.
  assert.equal(desfecho('CaptchaFalhaValidacao'), 'manual');
  // Documento recusado é problema do cadastro; insistir repete o mesmo dado errado.
  assert.equal(desfecho('DocumentoInvalido'), 'erro');
  assert.equal(desfecho('ContribuinteNaoEncontrado'), 'erro');
  // Acesso negado não se resolve sozinho.
  assert.equal(desfecho('NaoAutorizado'), 'manual');
  // E este é o único caso em que esperar faz sentido.
  assert.equal(desfecho('ServicoIndisponivel'), 'indisponivel');
});

test('status desconhecido não recebe recomendação inventada', async () => {
  const { traduzirValidacao } = await import('../src/provedores/web.js');

  const r = traduzirValidacao({ statusValidacao: 'AlgoQueNuncaVimos', codigo: '999' });

  assert.equal(r.situacao, 'manual');
  // O nome cru é o que permite descobrir o que ele significa da próxima vez.
  assert.match(r.detalhe, /AlgoQueNuncaVimos/);
  assert.match(r.detalhe, /diagnostico/i, 'aponta como investigar em vez de adivinhar');
  assert.doesNotMatch(r.detalhe, /aguarde|tente novamente/i);
});

/**
 * A recusa que não é passageira não pode custar três esperas.
 *
 * A tela diz "tente novamente dentro de alguns minutos" tanto quando o portal
 * piscou quanto quando o captcha reprovou — situações opostas. A tradução da
 * resposta da API existia, mas acontecia DEPOIS do laço de tentativas: o
 * captcha ainda custava 30s + 60s de espera por cliente para chegar ao mesmo
 * não. Em vinte e dois clientes, meia hora jogada fora.
 */
test('só repete o que tem chance de mudar', async () => {
  const { deveRepetir } = await import('../src/receitas/index.js');

  const caso = (extra) =>
    deveRepetir({ situacao: 'indisponivel', tentativa: 1, tentativas: 3, ...extra });

  // Portal que piscou: repetir resolve.
  assert.equal(caso({ repetirFazSentido: () => true }), true);
  // Captcha reprovado: vai reprovar de novo. Nem uma espera.
  assert.equal(caso({ repetirFazSentido: () => false }), false);
  // Sem resposta da API, vale a leitura da tela — que pede para repetir.
  assert.equal(caso({}), true);

  // E o resto das regras continua valendo.
  assert.equal(caso({ tentativa: 3, repetirFazSentido: () => true }), false, 'última tentativa');
  assert.equal(
    deveRepetir({ situacao: 'negativa', tentativa: 1, tentativas: 3, repetirFazSentido: () => true }),
    false,
    'desfecho bom não se repete',
  );
});
