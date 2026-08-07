#!/usr/bin/env node
/**
 * A fila de emissão: a máquina faz tudo, menos o que só uma pessoa pode fazer.
 *
 * O portal da Receita recusa navegador automatizado — o captcha reprova antes
 * mesmo de apresentar desafio (DIARIO.md, seção 4.11). Não há como a máquina
 * emitir. Mas quase tudo o que cerca a emissão é trabalho de máquina:
 *
 * - saber **quem** precisa de certidão este mês (quem já tem uma vigente fica
 *   de fora, e uma CND federal vale 180 dias);
 * - saber **em que ordem**, e não perder a conta no meio de vinte e dois;
 * - ter o CNPJ **na área de transferência** na hora de colar;
 * - abrir o portal no **seu** navegador, o de verdade, onde o captcha não
 *   implica com ninguém;
 * - e no fim, recolher os PDFs baixados e arquivar cada um no cliente certo.
 *
 * O que sobra para você: colar, clicar em Emitir, salvar. Três gestos por
 * cliente, sem digitar CNPJ nenhum e sem conferir lista.
 *
 *   npm run fila
 *   npm run fila -- --certidao rfb_pgfn
 *   npm run fila -- --forcar        # inclui quem já tem certidão vigente
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { carregarConfig } from './config.js';
import { carregarVigentes, chaveDe } from './vigencia.js';
import { formatar, limpar } from './documentos.js';
import { CATALOGO } from './catalogo.js';
import { perguntarTexto } from './senha.js';
import { chamadoDireto } from './executavel.js';
import { importar } from './importar.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PORTAIS = {
  rfb_pgfn: {
    cnpj: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj',
    cpf: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cpf',
  },
  cndt: { cnpj: 'https://cndt-certidao.tst.jus.br/inicio.faces' },
  fgts_crf: { cnpj: 'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf' },
  sefaz_sc: { cnpj: 'https://sat.sef.sc.gov.br/tax.NET/Sat.CtaCte.Web/SolicitacaoCnd.aspx' },
};

/**
 * Quem ainda precisa de certidão nesta competência.
 *
 * Quem já tem uma vigente fica de fora: uma CND federal vale 180 dias, e pedir
 * de novo é gastar um gesto humano à toa. É essa conta que transforma "vinte e
 * duas emissões por mês" em "vinte e duas por semestre".
 */
export function quemFalta(config, idCertidao, vigentes, { forcar = false } = {}) {
  return (config.clientes ?? [])
    .filter((c) => c.ativo !== false)
    .filter((c) => (c.certidoes ?? config.certidoes ?? []).includes(idCertidao))
    .map((c) => {
      const vigente = vigentes.get(chaveDe(c.documento, idCertidao));
      return { ...c, vigente };
    })
    .filter((c) => forcar || !c.vigente);
}

/** O endereço do portal para este cliente. */
export function portalDe(idCertidao, tipo = 'cnpj') {
  const p = PORTAIS[idCertidao];
  return p?.[tipo] ?? p?.cnpj ?? null;
}

/**
 * Põe o documento na área de transferência e abre o portal.
 *
 * Os dois comandos são do sistema, não do programa, e ficam injetáveis para o
 * teste não depender de ter um Mac com navegador na frente.
 */
export async function prepararCliente(cliente, url, executar = rodarComando) {
  const so = limpar(cliente.documento);
  await executar('pbcopy', [], so);
  if (url) await executar('open', [url]);
  return so;
}

function rodarComando(comando, args, entrada) {
  return new Promise((ok) => {
    const p = spawn(comando, args, { stdio: [entrada ? 'pipe' : 'ignore', 'ignore', 'ignore'] });
    p.on('error', () => ok(false));
    p.on('close', () => ok(true));
    if (entrada) {
      p.stdin.write(entrada);
      p.stdin.end();
    }
  });
}

if (chamadoDireto(import.meta.url)) {
  const args = process.argv.slice(2);
  const valor = (nome) => {
    const i = args.indexOf(`--${nome}`);
    return i >= 0 ? args[i + 1] : null;
  };

  const idCertidao = valor('certidao') ?? 'rfb_pgfn';
  const forcar = args.includes('--forcar');

  const config = await carregarConfig(resolve(RAIZ, 'clientes.json'));
  const vigentes = await carregarVigentes(resolve(RAIZ, 'historico'));
  const fila = quemFalta(config, idCertidao, vigentes, { forcar });

  const nomeCertidao = CATALOGO[idCertidao]?.nome ?? idCertidao;

  if (fila.length === 0) {
    console.log(`\n  ${nomeCertidao}: ninguém precisa. Todos com certidão vigente.`);
    console.log('  Use --forcar para emitir mesmo assim.\n');
    process.exit(0);
  }

  console.log(`\n  ${nomeCertidao} · ${fila.length} cliente(s) a emitir\n`);
  console.log('  Para cada um: o CNPJ vai para a área de transferência e o portal abre');
  console.log('  no seu navegador. Cole (⌘V), clique em Emitir e salve o PDF.');
  console.log('  Enter passa ao próximo · "s" encerra a fila.\n');

  let feitos = 0;
  for (const [i, cliente] of fila.entries()) {
    const url = portalDe(idCertidao, cliente.tipo);
    await prepararCliente(cliente, url);

    console.log(`  [${i + 1}/${fila.length}] ${cliente.nome}`);
    console.log(`            ${formatar(limpar(cliente.documento))}  ← já está na área de transferência`);

    const resposta = await perguntarTexto('            Enter para o próximo · s para encerrar: ');
    feitos += 1;
    if (resposta.toLowerCase() === 's') break;
  }

  console.log(`\n  ${feitos} de ${fila.length} percorrido(s). Recolhendo o que foi baixado...\n`);

  // O passo seguinte e sempre o mesmo, entao ele nao precisa de outro comando:
  // os PDFs acabaram de cair na pasta de downloads.
  const downloads = valor('downloads') ?? resolve(process.env.HOME ?? '~', 'Downloads');
  const { importados, historico } = await importar([downloads]);
  const entraram = importados.filter((x) => !x.erro && !x.ignorado);

  for (const x of entraram) {
    const validade = x.validaAte ? ` · vale até ${x.validaAte}` : '';
    console.log(`  ✓ ${x.cliente} · ${x.situacao}${validade}`);
  }
  console.log(`\n  ${entraram.length} certidão(ões) arquivada(s).`);
  if (historico) console.log(`  Histórico: ${historico}\n`);
}
