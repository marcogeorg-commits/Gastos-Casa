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

  // Outra recusa qualquer também é nomeada, em vez de virar "indisponível".
  const outra = traduzirValidacao({ statusValidacao: 'DocumentoInvalido', codigo: '011' });
  assert.equal(outra.situacao, 'manual');
  assert.match(outra.detalhe, /DocumentoInvalido/);

  // Sem resposta de API, quem manda continua sendo a leitura da tela.
  assert.equal(traduzirValidacao(null), null);
  assert.equal(traduzirValidacao({}), null);
});
