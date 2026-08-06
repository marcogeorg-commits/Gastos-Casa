#!/usr/bin/env node
/**
 * Calibração de seletores.
 *
 * Abre o portal de uma certidão, lista os campos e botões que existem de fato e
 * diz se há captcha. Serve para preencher `src/receitas/index.js` sem adivinhar:
 *
 *   npm run calibrar -- rfb_pgfn
 *   npm run calibrar -- rfb_pgfn --tipo cpf
 *   npm run calibrar -- cndt --headed
 *   npm run calibrar -- cadin_federal --cliente "Alfa"   # e-CAC, com certificado
 *
 * Precisa rodar de uma máquina com acesso aos portais (o ambiente do agente e
 * os runners do GitHub Actions costumam não ter).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDS_RECEITAS, RECEITAS } from './receitas/index.js';
import { IDS_ECAC, LOGIN_ECAC, PASSOS_LOGIN, RECEITAS_ECAC } from './receitas/ecac.js';
import { inventariar } from './inventario.js';
import { detectarCaptcha, esperarSeletor, primeiroVisivel } from './provedores/web.js';
import { abrirContexto, autenticado } from './provedores/ecac.js';
import { PASTA_CERTIFICADOS_PADRAO, carregarConfig } from './config.js';
import { listarCertificados, resolverCertificado } from './certificados.js';
import { escolherCertificado, gravarVinculo, lerVinculos } from './vinculos.js';
import { lerCertificado } from './certificado-info.js';
import { formatar, limpar, tipoDocumento, validar } from './documentos.js';
import { perguntarSenha, perguntarTexto } from './senha.js';
import { chamadoDireto } from './executavel.js';

// Reexportado: o inventário saiu daqui para poder servir também ao provedor do
// e-CAC, mas continua fazendo parte do que a calibração oferece.
export { inventariar };

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ESPERA_APP = 30_000;

/**
 * Espera o app renderizar algum controle.
 *
 * Sem isso o inventário fotografa a página no instante do `goto` -- num SPA,
 * antes de existir formulário -- e conclui, errado, que o portal não tem campo
 * nenhum. Usa locator (que atravessa shadow DOM) em vez de querySelector.
 */
export async function esperarApp(pagina, tempoLimite = ESPERA_APP) {
  await pagina.waitForLoadState('networkidle').catch(() => {});
  try {
    await pagina
      .locator('input:not([type=hidden]), select, textarea, button')
      .first()
      .waitFor({ state: 'attached', timeout: tempoLimite });
    return true;
  } catch {
    return false;
  }
}

/**
 * Alvo da calibracao a partir do cadastro.
 *
 * Continua servindo para quem ja tem a carteira montada e quer testar um
 * cliente especifico.
 */
async function alvoPorCadastro(opcoes) {
  const config = await carregarConfig(resolve(RAIZ, opcoes.clientes ?? 'clientes.json'));

  const cliente = opcoes.cliente
    ? config.clientes.find((c) => c.nome.toLowerCase().includes(opcoes.cliente.toLowerCase()))
    : config.clientes.find((c) => c.certificado);

  if (!cliente) {
    throw new Error(
      opcoes.cliente
        ? `Nenhum cliente com nome contendo "${opcoes.cliente}".`
        : 'Nenhum cliente do cadastro tem certificado configurado. Use --documento <CNPJ> para calibrar sem cadastrar.',
    );
  }

  const certificado = await resolverCertificado(cliente, config, process.env);
  if (certificado.erro) throw new Error(certificado.erro);
  return { cliente, config, certificado };
}

/**
 * Quando o programa nao sabe qual arquivo e, quem sabe e o operador.
 *
 * A alternativa era abortar com "nenhum certificado com este CNPJ no nome" --
 * mensagem que manda o operador renomear 23 arquivos para agradar o programa,
 * quando a informacao esta dentro deles.
 */
async function escolherNaMao(arquivos, documento, pasta) {
  console.log(`\nNenhum arquivo em ${pasta} identificado como ${formatar(documento)}.`);
  console.log('Escolha qual é (o nome do arquivo raramente traz o CNPJ):\n');
  arquivos.forEach((nome, i) => console.log(`  ${String(i + 1).padStart(2)}. ${nome}`));

  const resposta = await perguntarTexto('\nNúmero: ');
  const indice = Number(resposta) - 1;
  if (!Number.isInteger(indice) || indice < 0 || indice >= arquivos.length) {
    throw new Error(`"${resposta}" não está na lista.`);
  }
  return arquivos[indice];
}

/**
 * Alvo da calibracao a partir do CNPJ, sem passar pelo cadastro.
 *
 * Exigir cadastro antes de calibrar invertia a ordem das coisas: o cadastro e
 * o compromisso de acompanhar um cliente todo mes, e calibrar e justamente
 * descobrir se ha o que acompanhar. Com o `.pfx` na pasta e o CNPJ na mao ja
 * ha tudo que a calibracao precisa.
 */
async function alvoPorDocumento(documento) {
  const bruto = limpar(documento);
  if (!validar(bruto)) throw new Error(`"${documento}" não é um CNPJ nem um CPF válido.`);

  const config = { certificados: { pastaPadrao: PASTA_CERTIFICADOS_PADRAO } };
  const { pasta, arquivos, erro } = await listarCertificados(
    config.certificados.pastaPadrao,
    RAIZ,
  );
  if (erro) throw new Error(erro);

  // Primeiro a escolha ja feita pelo operador, depois o palpite pelo nome do
  // arquivo. A ordem importa: muitas autoridades nomeiam o `.pfx` pelo numero
  // do pedido, e ai o palpite falha dizendo "nao existe" com o arquivo na
  // pasta. Era exatamente o que a calibracao fazia -- a consulta ja tinha sido
  // corrigida, esta ficou para tras.
  const vinculos = await lerVinculos(RAIZ);
  let arquivo = escolherCertificado(arquivos, bruto, vinculos);

  if (!arquivo) {
    if (arquivos.length === 0) throw new Error(`Nenhum certificado em ${pasta}.`);
    arquivo = await escolherNaMao(arquivos, bruto, pasta);
  }

  console.log(`Certificado: ${arquivo}`);
  const senha = await perguntarSenha();
  if (!senha) throw new Error('Senha vazia.');

  // Confere de quem e o certificado antes de gastar uma ida ao portal, e grava
  // a escolha para nao perguntar de novo. O titular vem de dentro do `.pfx`:
  // e a unica fonte que nao depende de como o arquivo foi nomeado.
  const info = await lerCertificado(resolve(pasta, arquivo), senha).catch(() => null);
  if (info?.documento && limpar(info.documento) !== bruto) {
    throw new Error(
      `Este certificado é de ${info.nome ?? 'outro titular'} (${formatar(info.documento)}), ` +
        `não de ${formatar(bruto)}. Escolha outro arquivo.`,
    );
  }
  if (info?.documento) await gravarVinculo(bruto, arquivo, RAIZ);

  return {
    cliente: { nome: formatar(bruto), documento: bruto, tipo: tipoDocumento(bruto) },
    config,
    certificado: { caminho: resolve(pasta, arquivo), senha, variavel: '(digitada agora)' },
  };
}

/**
 * Calibração do e-CAC: entra com o certificado e inventaria a tela autenticada.
 * Sem entrar, o inventário seria o da página de login — que não tem relação com
 * o serviço que se quer automatizar.
 */
export async function calibrarEcac(idCertidao, opcoes = {}) {
  const receita = RECEITAS_ECAC[idCertidao];
  const { cliente, certificado } = opcoes.documento
    ? await alvoPorDocumento(opcoes.documento)
    : await alvoPorCadastro(opcoes);

  const { chromium } = await import('playwright');
  const navegador = await chromium.launch({
    headless: !opcoes.headed,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox'],
  });

  try {
    const contexto = await abrirContexto(navegador, certificado);
    const pagina = await contexto.newPage();
    pagina.setDefaultTimeout(60_000);

    console.log(`Cliente: ${cliente.nome} · certificado: ${certificado.caminho}`);
    process.stdout.write(`Abrindo ${LOGIN_ECAC} ... `);
    const resposta = await pagina.goto(LOGIN_ECAC, { waitUntil: 'domcontentloaded' });
    console.log(`HTTP ${resposta?.status() ?? '?'}`);

    await esperarApp(pagina);
    const entrou = await autenticado(pagina);
    console.log(entrou ? 'Sessão autenticada.' : 'NÃO autenticou — o inventário abaixo é da tela de login.');

    const inventario = await inventariar(pagina);
    console.log(`\nTítulo: ${inventario.titulo}`);

    // Quando NAO autentica, o que interessa e o caminho de entrada -- e ele e
    // feito de botoes, nao de links. Listar so os links de servico deixava a
    // tela de login sem inventario nenhum: era possivel ver que a pagina
    // carregou e continuar sem saber em que clicar.
    console.log(`\nBotões (${inventario.botoes.length}):`);
    for (const b of inventario.botoes) {
      console.log(`  ${b.seletor ?? `${b.tag}:has-text("${b.texto ?? ''}")`}  ·  ${b.texto ?? b.aria ?? '(sem texto)'}`);
    }

    console.log(`\nCampos (${inventario.campos.length}):`);
    for (const c of inventario.campos) {
      console.log(`  ${c.seletor ?? c.tag}  ·  ${c.texto ?? c.placeholder ?? c.aria ?? '(sem rótulo)'}`);
    }

    console.log(`\nLinks de serviço que casam com a receita:`);
    for (const candidato of receita.caminhoServico) {
      const achou = (await pagina.locator(candidato).count()) > 0;
      console.log(`  ${candidato}: ${achou ? 'OK' : 'não encontrado'}`);
    }

    console.log(`\nPassos de login que casam:`);
    for (const passo of PASSOS_LOGIN) {
      const achou = await primeiroVisivel(pagina, passo.candidatos);
      console.log(`  ${passo.nome}: ${achou ? 'OK' : 'nenhum candidato visível'}`);
    }

    console.log(`\nTexto visível:\n  ${inventario.textoVisivel}`);

    const pasta = resolve(RAIZ, 'calibracao');
    await mkdir(pasta, { recursive: true });
    // Prefixo `ecac-` porque essa captura mostra a tela autenticada de um
    // cliente: o .gitignore a mantém fora do versionamento por esse nome.
    await pagina.screenshot({ path: resolve(pasta, `ecac-${idCertidao}.png`), fullPage: true });
    console.log(`\nCaptura salva em calibracao/ecac-${idCertidao}.png (fora do versionamento).`);

    return { autenticado: entrou, ...inventario };
  } finally {
    await navegador.close().catch(() => {});
  }
}

export async function calibrar(idCertidao, opcoes = {}) {
  if (RECEITAS_ECAC[idCertidao]) return calibrarEcac(idCertidao, opcoes);

  const receita = RECEITAS[idCertidao];
  if (!receita) {
    throw new Error(
      `Sem receita para "${idCertidao}". Disponíveis: ${[...IDS_RECEITAS, ...IDS_ECAC].join(', ')}.`,
    );
  }

  const { chromium } = await import('playwright');
  const navegador = await chromium.launch({
    headless: !opcoes.headed,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox'],
  });

  try {
    const pagina = await navegador.newPage({ locale: 'pt-BR' });
    pagina.setDefaultTimeout(45_000);

    // Percorre todas as URLs da receita e fica na primeira que abrir: o
    // diagnóstico precisa dizer qual endereço ainda está de pé.
    const urls = receita.urlsPara?.({ tipo: opcoes.tipo ?? 'cnpj' }) ?? receita.urls;
    let urlAberta = null;
    for (const url of urls) {
      process.stdout.write(`Abrindo ${url} ... `);
      try {
        const resposta = await pagina.goto(url, { waitUntil: 'domcontentloaded' });
        console.log(`HTTP ${resposta?.status() ?? '?'}`);
        urlAberta = url;
        break;
      } catch (erro) {
        console.log(`falhou (${erro.message.split('\n')[0]})`);
      }
    }

    if (!urlAberta) {
      throw new Error('Nenhuma URL da receita abriu a partir desta máquina.');
    }

    process.stdout.write('Esperando o app renderizar ... ');
    const renderizou = await esperarApp(pagina);
    console.log(renderizou ? 'ok' : `nada apareceu em ${ESPERA_APP / 1000}s`);

    // Alguns portais nao mostram o formulario na entrada: o CNDT abre so com
    // "Emitir Certidao" e "Validar Certidao", e o campo do documento esta na
    // tela seguinte. Sem percorrer a preparacao, o inventario descreveria a
    // porta e nunca a sala -- foi exatamente o que aconteceu na primeira
    // calibracao dele.
    const passos = receita.preparacao ?? [];
    if (passos.length > 0) {
      console.log(`\nPreparação (${passos.length} passo${passos.length === 1 ? '' : 's'}):`);
      for (const passo of passos) {
        const alvo = await primeiroVisivel(pagina, passo.candidatos);
        if (!alvo) {
          console.log(`  ${passo.nome ?? passo.candidatos[0]} — não está na tela, pulado`);
          continue;
        }
        await alvo.click({ timeout: 5000 }).catch(() => {});
        await pagina.waitForLoadState('networkidle').catch(() => {});
        await esperarApp(pagina);
        console.log(`  ${passo.nome ?? passo.candidatos[0]} — clicado`);
      }
    }

    const captcha = await detectarCaptcha(pagina);
    const inventario = await inventariar(pagina);

    console.log(`\nURL: ${pagina.url()}`);
    console.log(`Entrada: ${urlAberta}`);
    console.log(`Título: ${inventario.titulo}`);
    console.log(
      captcha
        ? `Captcha detectado: ${captcha.provedor} ${
            captcha.bloqueante ? 'VISÍVEL (bloqueia a automação)' : 'invisível'
          } — ${captcha.seletor}`
        : 'Sem captcha aparente.',
    );

    console.log(`\nCampos (${inventario.campos.length}):`);
    for (const c of inventario.campos) {
      const rotulo = c.placeholder ?? c.aria ?? '';
      console.log(`  ${c.seletor ?? '(sem id/name)'}  ${c.type ?? c.tag}  ${rotulo}`);
    }

    console.log(`\nBotões (${inventario.botoes.length}):`);
    for (const b of inventario.botoes) {
      console.log(`  ${b.seletor ?? '(sem id/name)'}  "${b.texto ?? ''}"`);
    }

    if (inventario.tagsCustomizadas.length > 0) {
      console.log(`\nComponentes: ${inventario.tagsCustomizadas.slice(0, 20).join(', ')}`);
    }
    if (inventario.iframes.length > 0) {
      console.log(`\nIframes: ${inventario.iframes.join(', ')}`);
    }

    // Sem controle nenhum, o texto da página é o que explica o porquê.
    if (inventario.campos.length === 0 && inventario.botoes.length === 0) {
      console.log(`\nA página não expôs controles. Texto visível:\n  ${inventario.textoVisivel}`);
      console.log(`  (HTML com ${inventario.html} caracteres)`);
    }

    console.log('\nSeletores da receita atual:');
    for (const [papel, candidatos] of Object.entries(receita.seletores)) {
      // Espera curta: o elemento pode aparecer depois do primeiro render.
      const encontrado = await esperarSeletor(pagina, candidatos, 3000);
      console.log(`  ${papel}: ${encontrado ? `OK → ${encontrado}` : 'NENHUM candidato casou'}`);
    }

    const pasta = resolve(RAIZ, 'calibracao');
    await mkdir(pasta, { recursive: true });
    await pagina.screenshot({ path: resolve(pasta, `${idCertidao}.png`), fullPage: true });
    await writeFile(
      resolve(pasta, `${idCertidao}.json`),
      `${JSON.stringify({ url: urlAberta, urlsTentadas: urls, captcha, ...inventario }, null, 2)}\n`,
      'utf8',
    );
    console.log(`\nInventário e captura salvos em calibracao/${idCertidao}.*`);

    return { captcha, ...inventario };
  } finally {
    await navegador.close().catch(() => {});
  }
}

if (chamadoDireto(import.meta.url)) {
  const argv = process.argv.slice(2);
  const idCertidao = argv.find((a) => !a.startsWith('--'));
  const headed = argv.includes('--headed');
  const tipo = argv[argv.indexOf('--tipo') + 1];
  const cliente = argv[argv.indexOf('--cliente') + 1];
  const documento = argv[argv.indexOf('--documento') + 1];

  if (!idCertidao) {
    console.error(
      `Uso: npm run calibrar -- <certidao> [opções]\n\n` +
        `  --documento <CNPJ>   calibra o e-CAC sem cadastrar: acha o .pfx pelo\n` +
        `                       CNPJ no nome do arquivo e pede a senha na hora\n` +
        `  --cliente <nome>     usa um cliente já cadastrado\n` +
        `  --tipo cpf           rota de pessoa física, onde o portal separa\n` +
        `  --headed             mostra o navegador\n\n` +
        `Portais públicos: ${IDS_RECEITAS.join(', ')}\n` +
        `e-CAC (exige certificado): ${IDS_ECAC.join(', ')}`,
    );
    process.exit(1);
  }

  calibrar(idCertidao, {
    headed,
    tipo: argv.includes('--tipo') ? tipo : undefined,
    cliente: argv.includes('--cliente') ? cliente : undefined,
    documento: argv.includes('--documento') ? documento : undefined,
  }).catch((erro) => {
    console.error(`Erro: ${erro.message}`);
    process.exit(1);
  });
}
