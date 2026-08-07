#!/usr/bin/env node
/**
 * Traz para dentro do sistema a certidão que foi emitida à mão.
 *
 * Existe porque um portal pode recusar a automação e ainda assim atender uma
 * pessoa — é o caso da CND Federal, cujo hCaptcha reprova o navegador
 * automatizado (ver DIARIO.md, seção 4.11). Sem este comando, emitir à mão
 * significava perder tudo o que vem depois: o arquivo organizado por cliente e
 * competência, o histórico, o aproveitamento da vigência e o relatório.
 *
 * O que ele faz com cada PDF:
 *
 * 1. lê o texto de dentro do documento — não confia no nome do arquivo;
 * 2. descobre de quem é (o CNPJ/CPF está escrito na certidão);
 * 3. descobre qual certidão é, pelo título dela;
 * 4. classifica a situação e extrai a validade;
 * 5. arquiva em `certidoes/AAAA-MM/<documento>_<NOME>/` e grava no histórico.
 *
 *   npm run importar -- ~/Downloads/Certidao42160865000165.pdf
 *   npm run importar -- ~/Downloads            # a pasta inteira
 *
 * Nada é adivinhado: PDF que não puder ser lido, ou cujo documento não estiver
 * no cadastro, é recusado com o motivo. Uma certidão arquivada no cliente
 * errado é pior que uma certidão faltando.
 */

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caminhoDoComprovante } from './comprovante.js';
import { carregarConfig } from './config.js';
import { extrairTextoPdf } from './pdf-texto.js';
import { extrairValidade } from './receitas/index.js';
import { interpretarTexto } from './situacao.js';
import { formatar, limpar } from './documentos.js';
import { CATALOGO } from './catalogo.js';
import { chamadoDireto } from './executavel.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Qual certidão é esta, pelo que está escrito nela.
 *
 * O título é o que distingue: "Débitos Relativos aos Tributos Federais e à
 * Dívida Ativa da União" é a CND Federal; "Débitos Trabalhistas" é a CNDT.
 * Confiar no nome do arquivo seria voltar ao erro dos certificados, em que o
 * programa deduzia do nome e errava.
 */
/**
 * A palavra "certidao", tolerante ao acento estragado.
 *
 * O deslocamento da fonte acerta as letras comuns e erra as acentuadas: no PDF
 * da Receita, "CERTIDÃO" chega como "CERTIDÊO". Exigir a grafia certa fazia o
 * programa recusar justamente as certidoes de verdade -- foi o que aconteceu
 * na primeira versao deste filtro, que sumiu com uma certidao ja importada.
 */
const CERTIDAO = /certid\S{0,2}o\b|certid\S{0,2}es\b|certificado de regularidade/i;

/**
 * Qual certidão é esta, pelo que está escrito nela.
 *
 * Cada marca é a frase que só aquela certidão tem. Marcas fracas -- nome de
 * estado, nome de banco -- exigem também a palavra "certidão", porque sozinhas
 * aparecem em nota fiscal, boleto e papel timbrado. "Caixa Econômica" saiu da
 * lista: está em todo boleto bancário.
 */
const ASSINATURAS = [
  { id: 'rfb_pgfn', marca: /tributos federais|d[ií]vida ativa da uni[ãa]o|procuradoria-geral da fazenda/i },
  { id: 'cndt', marca: /d[ée]bitos trabalhistas|banco nacional de devedores/i },
  { id: 'fgts_crf', marca: /regularidade do fgts|regularidade do empregador/i },
  { id: 'sefaz_sc', marca: /secretaria de estado da fazenda/i, exigeCertidao: true },
  { id: 'municipal', marca: /prefeitura|munic[ií]pio de/i, exigeCertidao: true },
];
/**
 * O documento se apresenta como certidão?
 *
 * Sem esta pergunta, "Santa Catarina" numa proposta comercial virava certidão
 * da SEFAZ/SC e "Prefeitura" num balancete virava certidão municipal. Com o
 * CNPJ no cadastro, o arquivo teria sido guardado como certidão do cliente --
 * e o relatório passaria a afirmar, com PDF anexado, uma situação que ninguém
 * apurou.
 */
export function pareceCertidao(texto) {
  return CERTIDAO.test(String(texto ?? ''));
}

export function reconhecerCertidao(texto) {
  const t = String(texto ?? '');
  const achada = ASSINATURAS.find((a) => a.marca.test(t));
  if (!achada) return null;

  // A marca forte fala por si; a fraca precisa da palavra ao lado.
  return !achada.exigeCertidao || pareceCertidao(t) ? achada.id : null;
}

/**
 * O documento do titular, lido de dentro da certidão.
 *
 * Aceita CNPJ e CPF, com ou sem pontuação, e devolve só os dígitos. A certidão
 * pode citar mais de um número (o do titular e o de um estabelecimento); vale
 * o que aparece logo depois do rótulo.
 */
export function extrairDocumento(texto) {
  const t = String(texto ?? '');
  const cnpj = t.match(/CNPJ[:\s]*([\d.\-/]{14,20})/i)?.[1];
  if (cnpj && limpar(cnpj).length === 14) return limpar(cnpj);

  const cpf = t.match(/CPF[:\s]*([\d.\-]{11,14})/i)?.[1];
  if (cpf && limpar(cpf).length === 11) return limpar(cpf);

  const solto = t.match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/)?.[0];
  return solto ? limpar(solto) : null;
}

/**
 * O pedaço legível da certidão, para o histórico e para o tooltip.
 *
 * O PDF traz fluxos que não são texto -- fontes, sobretudo -- e eles saem da
 * extração como ruído. Começar o trecho no título faz o histórico guardar a
 * frase que interessa em vez de bytes de fonte, que não provam nada a ninguém.
 */
export function trecho(texto, limite = 400) {
  const limpo = String(texto ?? '')
    .replace(/[^\x20-\x7e\u00c0-\u00ff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const inicio = limpo.search(/MINIST[ÉE]RIO|CERTID|SECRETARIA|CERTIFICADO/i);
  return (inicio > 0 ? limpo.slice(inicio) : limpo).slice(0, limite);
}

/**
 * O que este PDF é, sem ainda tocar em disco.
 *
 * A ordem das perguntas é o que separa ruído de problema. "Não é certidão" vem
 * primeiro e devolve `ignorado`, não `erro`: apontar uma pasta com duzentos
 * arquivos de escritório e receber duzentas linhas de falha esconde as duas
 * certidões que estavam lá no meio. Balancete não é falha; é balancete.
 *
 * Depois disso, sim, todo problema é reportado -- porque a partir dali se está
 * diante de uma certidão que deveria ter entrado e não entrou.
 */
export async function examinar(caminho, ler = readFile) {
  if (!/\.pdf$/i.test(caminho)) return { ignorado: 'não é um PDF' };

  const texto = await ler(caminho).then(extrairTextoPdf).catch(() => null);
  if (!texto) return { ignorado: 'não deu para ler o texto (digitalização ou PDF de imagem)' };

  const idCertidao = reconhecerCertidao(texto);
  if (!idCertidao) return { ignorado: 'não é uma certidão' };

  const documento = extrairDocumento(texto);
  if (!documento) return { erro: 'é certidão, mas não achei CNPJ nem CPF dentro dela', idCertidao };

  const situacao = interpretarTexto(texto);
  if (!situacao) return { erro: 'não consegui classificar a situação', documento, idCertidao };

  return {
    documento,
    idCertidao,
    situacao,
    validaAte: extrairValidade(texto),
    // O trecho vai para o histórico e para o tooltip do relatório: é a prova
    // do que foi lido, e permite conferir sem reabrir o arquivo.
    detalhe: trecho(texto),
  };
}

/** A competência a que a certidão pertence: a do mês, salvo indicação. */
export function competenciaDe(agora = new Date()) {
  return `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function importarArquivo(caminho, { raiz = RAIZ, config, competencia }) {
  const achado = await examinar(caminho);
  if (achado.erro || achado.ignorado) return { caminho, ...achado };

  const cliente = config.clientes.find((c) => limpar(c.documento) === achado.documento);
  if (!cliente) {
    return {
      caminho,
      ...achado,
      erro:
        `${formatar(achado.documento)} não está no cadastro. Acrescente o cliente antes de ` +
        'importar — arquivar no cliente errado é pior que não arquivar.',
    };
  }

  const { pasta, arquivo } = caminhoDoComprovante({
    raiz,
    competencia,
    cliente: { ...cliente, documento: achado.documento },
    idCertidao: achado.idCertidao,
  });
  await mkdir(pasta, { recursive: true });
  await copyFile(caminho, arquivo);

  return { caminho, ...achado, cliente: cliente.nome, arquivo };
}

/** Junta o que foi importado ao histórico da competência. */
export async function gravarNoHistorico(importados, { raiz = RAIZ, competencia }) {
  const bons = importados.filter((i) => !i.erro && !i.ignorado);
  if (bons.length === 0) return null;

  const destino = resolve(raiz, 'historico', `${competencia}.json`);
  const atual = await readFile(destino, 'utf8')
    .then(JSON.parse)
    .catch(() => ({ geradoEm: null, avisos: [], resultados: [] }));

  const resultados = [...(atual.resultados ?? [])];

  for (const i of bons) {
    const linha = {
      cliente: i.cliente,
      documento: formatar(i.documento),
      certidao: i.idCertidao,
      certidaoNome: CATALOGO[i.idCertidao]?.nome ?? i.idCertidao,
      orgao: CATALOGO[i.idCertidao]?.orgao ?? null,
      situacao: i.situacao,
      validaAte: i.validaAte,
      detalhe: `Importada do documento emitido à mão. ${i.detalhe}`,
      arquivo: i.arquivo,
      origem: 'importada',
    };

    // Substitui a linha do mesmo cliente e certidao: reimportar corrige, nao
    // duplica. Sem isso o relatorio mostraria a mesma certidao duas vezes com
    // desfechos diferentes, e nao ha como saber qual vale.
    const mesmo = resultados.findIndex(
      (r) => limpar(r.documento) === i.documento && r.certidao === i.idCertidao,
    );
    if (mesmo >= 0) resultados[mesmo] = linha;
    else resultados.push(linha);
  }

  await mkdir(dirname(destino), { recursive: true });
  await writeFile(
    destino,
    `${JSON.stringify({ ...atual, geradoEm: new Date().toISOString(), resultados }, null, 2)}\n`,
    'utf8',
  );
  return destino;
}

/** Um caminho pode ser um arquivo ou uma pasta cheia deles. */
export async function expandir(caminhos) {
  const arquivos = [];
  for (const caminho of caminhos) {
    const info = await stat(caminho).catch(() => null);
    if (!info) continue;

    if (info.isDirectory()) {
      const nomes = await readdir(caminho).catch(() => []);
      for (const nome of nomes.sort()) {
        if (extname(nome).toLowerCase() === '.pdf') arquivos.push(resolve(caminho, nome));
      }
    } else {
      arquivos.push(resolve(caminho));
    }
  }
  return arquivos;
}

export async function importar(caminhos, opcoes = {}) {
  const raiz = opcoes.raiz ?? RAIZ;
  const competencia = opcoes.competencia ?? competenciaDe();
  const config = opcoes.config ?? (await carregarConfig(resolve(raiz, 'clientes.json')));

  const arquivos = await expandir(caminhos);
  const importados = [];
  for (const arquivo of arquivos) {
    importados.push(await importarArquivo(arquivo, { raiz, config, competencia }));
  }

  const historico = await gravarNoHistorico(importados, { raiz, competencia });
  return { competencia, importados, historico };
}

if (chamadoDireto(import.meta.url)) {
  const alvos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const tudo = process.argv.includes('--tudo');

  if (alvos.length === 0) {
    console.error(`
  Traz para dentro do sistema a certidão emitida à mão.

    npm run importar -- ~/Downloads/Certidao42160865000165.pdf
    npm run importar -- ~/Downloads
    npm run importar -- ~/Downloads --tudo    # lista também o que foi ignorado

  Lê o documento por dentro: descobre de quem é, qual certidão é, se está
  negativa e até quando vale. Arquiva por cliente e grava no histórico.
`);
    process.exit(1);
  }

  const { competencia, importados, historico } = await importar(alvos);

  const entraram = importados.filter((i) => !i.erro && !i.ignorado);
  const problemas = importados.filter((i) => i.erro);
  const ignorados = importados.filter((i) => i.ignorado);
  const nome = (c) => c.split('/').pop();

  console.log(`\n  Competência ${competencia} · ${importados.length} arquivo(s) examinado(s)\n`);

  // O que entrou vem primeiro e sozinho. Numa pasta de escritorio com duzentos
  // arquivos, as duas certidoes que estavam la nao podem aparecer no meio de
  // duzentas linhas de "nao e certidao".
  if (entraram.length === 0) {
    console.log('  Nenhuma certidão encontrada.');
  }
  for (const i of entraram) {
    const validade = i.validaAte ? ` · vale até ${i.validaAte}` : '';
    console.log(`  ✓ ${i.cliente}`);
    console.log(`    ${CATALOGO[i.idCertidao]?.nome ?? i.idCertidao} · ${i.situacao}${validade}`);
    console.log(`    ${i.arquivo}\n`);
  }

  // Problema e o que era certidao e nao entrou. Isso o operador resolve.
  if (problemas.length > 0) {
    console.log(`  ${problemas.length} certidão(ões) com problema:\n`);
    for (const i of problemas) console.log(`  ✗ ${nome(i.caminho)}\n    ${i.erro}\n`);
  }

  // O resto e so o resto: balancete nao e falha, e balancete.
  if (ignorados.length > 0) {
    console.log(`  ${ignorados.length} arquivo(s) ignorado(s) — não são certidões.`);
    if (tudo) for (const i of ignorados) console.log(`    · ${nome(i.caminho)} — ${i.ignorado}`);
    else console.log('    Use --tudo para listá-los.');
  }

  if (historico) console.log(`\n  Histórico: ${historico}\n`);
}
