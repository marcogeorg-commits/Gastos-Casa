/**
 * Baixa a cadeia de certificação de um portal para a pasta `ca/`.
 *
 * Por que isto é preciso: quando o servidor manda a cadeia incompleta, o
 * navegador vai atrás do certificado intermediário que falta — o endereço para
 * buscá-lo vem escrito dentro do próprio certificado, no campo "CA Issuers".
 * O Node não faz essa busca. Daí "no navegador abre e aqui não", com a
 * mensagem "unable to verify the first certificate", que soa como problema do
 * certificado do cliente e não é.
 *
 * Este módulo faz o que o navegador faria: pega o que o servidor mandou, e
 * enquanto o topo da cadeia não for autoassinado, busca o emissor no endereço
 * anunciado. O que junta vai para `ca/<portal>.pem`.
 *
 * O certificado do próprio site fica de fora: confiar nele individualmente
 * autenticaria aquele servidor sem verificar cadeia nenhuma. O que se guarda
 * são as autoridades.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { resolve } from 'node:path';

import { PASTA_CA } from './ca-sistema.js';
import { chamadoDireto } from './executavel.js';
import { ORIGENS_CERTIFICADO } from './receitas/ecac.js';

const LIMITE_SALTOS = 6;

/** O certificado é a raiz da cadeia quando assina a si mesmo. */
export function autoassinado(certificado) {
  return certificado.subject === certificado.issuer;
}

/**
 * Onde buscar o emissor.
 *
 * O campo `infoAccess` vem como texto solto; interessa só a linha do
 * "CA Issuers", e dela só endereços http — os `ldap:` não têm como ser
 * buscados aqui.
 */
export function enderecoDoEmissor(certificado) {
  const linhas = String(certificado?.infoAccess ?? '').split('\n');
  for (const linha of linhas) {
    if (!/CA Issuers/i.test(linha)) continue;
    const endereco = linha.match(/URI:\s*(https?:\/\/\S+)/i)?.[1];
    if (endereco) return endereco.trim();
  }
  return null;
}

/** O que o servidor mandou, do certificado do site para cima. */
export function cadeiaDoSocket(socket) {
  const cadeia = [];
  let atual = socket.getPeerX509Certificate?.();
  const vistos = new Set();

  while (atual && !vistos.has(atual.fingerprint256) && cadeia.length < LIMITE_SALTOS) {
    vistos.add(atual.fingerprint256);
    cadeia.push(atual);
    const acima = atual.issuerCertificate;
    // Raiz autoassinada aponta para si mesma: sem esta parada, laço infinito.
    atual = acima && acima.fingerprint256 !== atual.fingerprint256 ? acima : null;
  }
  return cadeia;
}

export async function conectar(host, porta = 443) {
  return new Promise((ok, falha) => {
    // Sem verificar de propósito: é justamente a verificação que não passa, e o
    // que se quer aqui é ver o que o servidor manda.
    const socket = connect(
      { host, port: porta, servername: host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] },
      () => ok(socket),
    );
    socket.setTimeout(20_000, () => socket.destroy(new Error('tempo esgotado')));
    socket.once('error', falha);
  });
}

async function baixarCertificado(endereco, buscar) {
  const resposta = await buscar(endereco);
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  const corpo = Buffer.from(await resposta.arrayBuffer());
  // O endereço pode devolver DER ou PEM; o construtor aceita os dois.
  return new X509Certificate(corpo);
}

/**
 * Completa a cadeia subindo pelos emissores anunciados.
 *
 * Falha em buscar não interrompe: uma cadeia parcial ainda pode ser o que
 * faltava, e interromper devolveria nada.
 */
export async function completar(cadeia, { buscar = fetch, registrar = () => {} } = {}) {
  const completa = [...cadeia];

  for (let salto = 0; salto < LIMITE_SALTOS; salto += 1) {
    const topo = completa.at(-1);
    if (!topo || autoassinado(topo)) break;

    const endereco = enderecoDoEmissor(topo);
    if (!endereco) {
      registrar(`  O certificado de "${topo.subject}" não diz onde buscar o emissor.`);
      break;
    }

    try {
      registrar(`  Buscando emissor em ${endereco}`);
      const emissor = await baixarCertificado(endereco, buscar);
      if (completa.some((c) => c.fingerprint256 === emissor.fingerprint256)) break;
      completa.push(emissor);
    } catch (erro) {
      registrar(`  Não deu para buscar: ${erro.message}`);
      break;
    }
  }

  return completa;
}

/**
 * Junta tudo e grava. Devolve o caminho e os nomes do que guardou.
 */
export async function guardarCadeia(
  host,
  { pasta = PASTA_CA, porta = 443, registrar = () => {}, ...resto } = {},
) {
  const socket = await conectar(host, porta);
  const doServidor = cadeiaDoSocket(socket);
  socket.destroy();

  if (doServidor.length === 0) throw new Error(`${host} não apresentou certificado.`);

  const completa = await completar(doServidor, { registrar, ...resto });
  // Fora o primeiro: aquele é o certificado do site, não uma autoridade.
  const autoridades = completa.slice(1);
  if (autoridades.length === 0) {
    throw new Error(`${host} mandou só o próprio certificado e não diz onde buscar o emissor.`);
  }

  await mkdir(pasta, { recursive: true });
  const caminho = resolve(pasta, `${host}.pem`);
  await writeFile(caminho, `${autoridades.map((c) => c.toString().trim()).join('\n')}\n`, 'utf8');

  return { caminho, autoridades: autoridades.map((c) => c.subject.replace(/\n/g, ' · ')) };
}

/** Sem argumento, cuida dos portais que o e-CAC atravessa no login. */
export function portaisPedidos(argv = process.argv.slice(2)) {
  const informados = argv.filter((a) => !a.startsWith('-'));
  if (informados.length > 0) return informados.map((a) => a.replace(/^https?:\/\//, '').split('/')[0]);
  return ORIGENS_CERTIFICADO.map((o) => new URL(o).hostname);
}

if (chamadoDireto(import.meta.url)) {
  console.log('\n  Baixando as cadeias de certificação\n');

  let guardadas = 0;
  for (const host of portaisPedidos()) {
    console.log(`  ${host}`);
    try {
      const { caminho, autoridades } = await guardarCadeia(host, {
        registrar: (m) => console.log(m),
      });
      for (const nome of autoridades) console.log(`    · ${nome}`);
      console.log(`    Guardado em ${caminho}\n`);
      guardadas += 1;
    } catch (erro) {
      console.log(`    Não deu: ${erro.message}\n`);
    }
  }

  console.log(
    guardadas > 0
      ? `  ${guardadas} cadeia(s) na pasta ca/. Rode a consulta de novo.\n`
      : '  Nenhuma cadeia baixada. Verifique a conexão com a internet.\n',
  );
}
