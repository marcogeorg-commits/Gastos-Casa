import { CATALOGO, descreverSituacao } from './catalogo.js';
import { descreverMudanca } from './historico.js';
import { CSS_MARCA, SITE, logoEmbutido, timbre } from './marca.js';

const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function esc(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * "2026-08" vira "agosto de 2026". Rotulo que nao seja competencia -- uma
 * rodada avulsa como `--competencia teste` -- volta como veio: montar a frase
 * assim mesmo produzia "undefined de NaN" no titulo do relatorio.
 */
function competenciaPorExtenso(competencia) {
  const casa = String(competencia ?? '').match(/^(\d{4})-(\d{2})$/);
  if (!casa) return String(competencia ?? '');

  const [, ano, mes] = casa;
  return `${MESES[Number(mes) - 1]} de ${ano}`;
}

/** Concordancia de numero: "1 cliente" e "10 clientes". */
function contar(quantidade, singular, plural) {
  return `${quantidade} ${quantidade === 1 ? singular : plural}`;
}

/**
 * Motivo em portugues de gente.
 *
 * O detalhe tecnico e util para quem for corrigir, mas o relatorio e lido por
 * quem precisa decidir o que fazer com o cliente. Despejar
 * "net::ERR_TUNNEL_CONNECTION_FAILED" ali nao informa ninguem.
 */
function motivoLegivel(detalhe) {
  const bruto = String(detalhe ?? '').trim();
  if (!bruto) return { frase: '', tecnico: '' };

  const regras = [
    [/net::|ERR_|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|tunnel|getaddrinfo/i,
      'Não foi possível acessar o portal do órgão a partir desta máquina — rede, proxy ou portal fora do ar.'],
    [/calibrar/i,
      'O layout do portal mudou e a automação não achou o que esperava. É preciso recalibrar os seletores.'],
    [/credenciais ausentes/i,
      'Faltam as credenciais do provedor contratado.'],
    [/captcha/i,
      'O portal exige verificação humana (captcha) para esta consulta.'],
    [/tente novamente|não foi possível concluir/i,
      'O sistema do órgão respondeu que não conseguiu concluir agora. Não é informação sobre o cliente.'],
    [/data de nascimento/i,
      'Falta a data de nascimento no cadastro deste cliente.'],
    [/senha deste certificado ainda não foi validada/i,
      'Falta validar a senha do certificado digital deste cliente no painel.'],
    [/sessão do e-CAC não abriu/i,
      'O e-CAC não abriu a sessão com este certificado — verifique validade, senha e procuração.'],
    [/não trouxe texto/i,
      'O portal respondeu sem conteúdo reconhecível.'],
  ];

  for (const [padrao, frase] of regras) {
    if (padrao.test(bruto)) return { frase, tecnico: bruto };
  }
  return { frase: bruto, tecnico: '' };
}

function dataHora(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function dataCurta(valor) {
  if (!valor) return '—';
  const m = String(valor).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(valor);
}

/** Agrupa os resultados por cliente, com as pendencias primeiro. */
function agruparPorCliente(resultados) {
  const mapa = new Map();
  for (const r of resultados) {
    if (!mapa.has(r.documento)) {
      mapa.set(r.documento, { nome: r.cliente, documento: r.documento, itens: [] });
    }
    mapa.get(r.documento).itens.push(r);
  }

  const clientes = [...mapa.values()];
  for (const cliente of clientes) {
    cliente.pendencias = cliente.itens.filter((i) => descreverSituacao(i.situacao).pendencia);
  }
  clientes.sort(
    (a, b) => b.pendencias.length - a.pendencias.length || a.nome.localeCompare(b.nome, 'pt-BR'),
  );
  return clientes;
}

function tile(valor, rotulo, apoio, status) {
  return `
      <div class="tile${status ? ` tile--${status}` : ''}">
        <div class="tile__valor">${esc(valor)}</div>
        <div class="tile__rotulo">${esc(rotulo)}</div>
        ${apoio ? `<div class="tile__apoio">${esc(apoio)}</div>` : ''}
      </div>`;
}

function selo(situacao, { curto = true } = {}) {
  const s = descreverSituacao(situacao);
  return `<span class="selo selo--${s.status}"><span class="selo__icone" aria-hidden="true">${s.icone}</span>${esc(curto ? s.curto : s.rotulo)}</span>`;
}

function linhaPendencia(item) {
  const s = descreverSituacao(item.situacao);
  const link = item.urlManual
    ? `<a class="pend__link" href="${esc(item.urlManual)}" target="_blank" rel="noopener">abrir portal do órgão</a>`
    : '';
  return `
        <li class="pend">
          <div class="pend__topo">
            <span class="pend__cliente">${esc(item.cliente)}</span>
            <span class="pend__doc">${esc(item.documento)}</span>
            ${selo(item.situacao, { curto: false })}
          </div>
          <div class="pend__certidao">${esc(item.certidaoNome)} · ${esc(item.orgao)}</div>
          <p class="pend__detalhe">${esc(motivoLegivel(item.detalhe).frase || s.rotulo)}</p>
          ${
            motivoLegivel(item.detalhe).tecnico
              ? `<p class="pend__tecnico">${esc(motivoLegivel(item.detalhe).tecnico)}</p>`
              : ''
          }
          ${link}
        </li>`;
}

/**
 * Consultas sem API acessivel (hoje: CADIN federal) repetem o mesmo motivo para
 * todos os clientes. Agrupa por certidao para explicar uma vez e listar quem
 * precisa ser conferido no portal.
 */
function secaoManual(manuais) {
  const porCertidao = new Map();
  for (const item of manuais) {
    if (!porCertidao.has(item.certidao)) porCertidao.set(item.certidao, { item, clientes: [] });
    porCertidao.get(item.certidao).clientes.push(item.cliente);
  }

  return [...porCertidao.values()]
    .map(({ item, clientes }) => {
      const link = item.urlManual
        ? `<a class="pend__link" href="${esc(item.urlManual)}" target="_blank" rel="noopener">abrir portal do órgão</a>`
        : '';
      return `
        <div class="manual">
          <div class="pend__topo">
            <span class="pend__cliente">${esc(item.certidaoNome)}</span>
            <span class="pend__doc">${esc(item.orgao)}</span>
            ${selo(item.situacao, { curto: false })}
          </div>
          <p class="pend__detalhe">${esc(item.detalhe ?? '')}</p>
          <div class="fichas">${clientes
            .map((nome) => `<span class="ficha">${esc(nome)}</span>`)
            .join('')}</div>
          ${link}
        </div>`;
    })
    .join('');
}

const ROTULO_MUDANCA = {
  piorou: 'Piorou',
  melhorou: 'Melhorou',
  novo: 'Nova',
  mudou: 'Mudou',
  removido: 'Removida',
};

/**
 * Entrar ou sair do cadastro gera uma mudanca por certidao -- seis linhas
 * iguais para um cliente novo, que afogariam as pioras de verdade. Vira uma
 * linha por cliente; so transicao de situacao merece detalhe por certidao.
 */
function secaoMudancas(comparacao) {
  const transicoes = comparacao.mudancas.filter(
    (m) => m.tipo !== 'novo' && m.tipo !== 'removido',
  );
  const cadastrais = comparacao.mudancas.filter(
    (m) => m.tipo === 'novo' || m.tipo === 'removido',
  );

  const porCliente = new Map();
  for (const m of cadastrais) {
    const item = m.atual ?? m.anterior;
    const chave = `${m.tipo}|${item.documento}`;
    if (!porCliente.has(chave)) {
      porCliente.set(chave, { tipo: m.tipo, item, certidoes: [] });
    }
    porCliente.get(chave).certidoes.push(item.certidaoNome);
  }

  const linhasTransicao = transicoes
    .map((m) => {
      const item = m.atual ?? m.anterior;
      return `
        <li class="pend">
          <div class="pend__topo">
            <span class="pend__cliente">${esc(item.cliente)}</span>
            <span class="pend__doc">${esc(item.documento)}</span>
            <span class="marca-mudanca marca-mudanca--${m.tipo}">${esc(ROTULO_MUDANCA[m.tipo])}</span>
            ${selo(m.atual?.situacao ?? m.anterior.situacao)}
          </div>
          <div class="pend__certidao">${esc(item.certidaoNome)}</div>
          <p class="pend__detalhe">${esc(descreverMudanca(m))}</p>
        </li>`;
    })
    .join('');

  const linhasCadastro = [...porCliente.values()]
    .map(
      ({ tipo, item, certidoes }) => `
        <li class="pend">
          <div class="pend__topo">
            <span class="pend__cliente">${esc(item.cliente)}</span>
            <span class="pend__doc">${esc(item.documento)}</span>
            <span class="marca-mudanca marca-mudanca--${tipo}">${esc(ROTULO_MUDANCA[tipo])}</span>
          </div>
          <p class="pend__detalhe">${
            tipo === 'novo'
              ? `entrou no monitoramento — ${certidoes.length} ${certidoes.length === 1 ? 'certidão' : 'certidões'}`
              : `saiu do monitoramento — ${certidoes.length} ${certidoes.length === 1 ? 'certidão' : 'certidões'}`
          }</p>
        </li>`,
    )
    .join('');

  return { html: linhasTransicao + linhasCadastro, total: transicoes.length + porCliente.size };
}

export function gerarHtml({ competencia, execucao, config, comparacao = null }) {
  const { resultados, resumo, avisos, geradoEm } = execucao;
  const clientes = agruparPorCliente(resultados);
  const colunas = config.certidoesAtivas.filter((id) =>
    resultados.some((r) => r.certidao === id),
  );

  const pendencias = resultados
    .filter((r) => descreverSituacao(r.situacao).pendencia)
    .sort((a, b) => a.cliente.localeCompare(b.cliente, 'pt-BR'));

  const mudancas = comparacao ? secaoMudancas(comparacao) : null;
  const manuais = resultados.filter((r) => descreverSituacao(r.situacao).manual);
  const regulares = resumo.consultas - pendencias.length - manuais.length;
  const statusGeral = resumo.clientesComPendencia === 0 ? 'good' : 'critical';

  const linhas = clientes
    .map((cliente) => {
      const porCertidao = new Map(cliente.itens.map((i) => [i.certidao, i]));
      const celulas = colunas
        .map((id) => {
          const item = porCertidao.get(id);
          if (!item) {
            return `<td class="celula celula--vazia"><span class="selo selo--neutro"><span class="selo__icone" aria-hidden="true">–</span>n/a</span></td>`;
          }
          // O caminho do comprovante fica na celula: e o que a pessoa vai
          // procurar para anexar num processo, e procurar pasta a pasta depois
          // e o trabalho que este programa deveria ter evitado.
          return `<td class="celula" title="${esc(item.detalhe ?? '')}">${selo(item.situacao)}${
            item.validaAte ? `<span class="celula__validade">vence ${esc(dataCurta(item.validaAte))}</span>` : ''
          }${
            item.arquivo
              ? `<a class="celula__validade" href="../${esc(item.arquivo)}" target="_blank" rel="noopener">documento</a>`
              : ''
          }</td>`;
        })
        .join('');

      return `
          <tr>
            <th scope="row" class="celula-cliente">
              <span class="celula-cliente__nome">${esc(cliente.nome)}</span>
              <span class="celula-cliente__doc">${esc(cliente.documento)}</span>
            </th>
            ${celulas}
          </tr>`;
    })
    .join('');

  const cabecalhos = colunas
    .map(
      (id) =>
        `<th scope="col"><span class="col__nome">${esc(CATALOGO[id].nome)}</span><span class="col__orgao">${esc(CATALOGO[id].orgao)}</span></th>`,
    )
    .join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monitor de Certidões — ${esc(competenciaPorExtenso(competencia))}</title>
<style>${CSS_MARCA}
  /* Só do relatório: ele é impresso e arquivado. */
  @media print {
    .timbre { background: #f2eee5 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    section { break-inside: avoid; }
    .rodape { border-top: 1px solid #e6e2d7; }
  }
</style>
</head>
<body>
${timbre({ logo: logoEmbutido(), direita: `<span class="assinatura">Monitor de Certidões</span>` })}

<div class="folha">
  <div class="titulo-pagina">
    <hr class="fio fio--curto">
    <h1>Certidões da carteira</h1>
    <p class="sub">Competência ${esc(competenciaPorExtenso(competencia))} · ${esc(contar(resumo.clientes, 'cliente monitorado', 'clientes monitorados'))}</p>
    <p class="meta">Gerado em ${esc(dataHora(geradoEm))} · origem dos dados: ${esc(config.provedorPadrao)}</p>
  </div>

  <div class="tiles">
    ${tile(resumo.clientes, 'Clientes monitorados', contar(colunas.length, 'certidão por cliente', 'certidões por cliente'))}
    ${tile(regulares, 'Certidões regulares', `de ${contar(resumo.consultas, 'consulta', 'consultas')}`, 'good')}
    ${tile(
      resumo.clientesComPendencia,
      'Clientes com débito ou falha',
      contar(pendencias.length, 'item aberto', 'itens abertos'),
      statusGeral,
    )}
    ${
      comparacao
        ? tile(
            comparacao.pioraram,
            'Pioraram no mês',
            `desde ${esc(competenciaPorExtenso(comparacao.competenciaAnterior))}`,
            comparacao.pioraram > 0 ? 'critical' : 'good',
          )
        : tile(manuais.length, 'Conferências manuais', 'sem API disponível')
    }
  </div>

  ${
    avisos.length > 0
      ? `<section>
    <h2>Avisos de cadastro e configuração</h2>
    <div class="cartao"><ul class="avisos">${avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>
  </section>`
      : ''
  }

  ${
    mudancas && mudancas.total > 0
      ? `<section>
    <h2>Mudanças desde ${esc(competenciaPorExtenso(comparacao.competenciaAnterior))} (${mudancas.total})</h2>
    <div class="cartao"><ul class="pendencias">${mudancas.html}</ul></div>
  </section>`
      : ''
  }

  <section>
    <h2>Itens que exigem ação (${pendencias.length})</h2>
    <div class="cartao">
      ${
        pendencias.length === 0
          ? '<p class="pend__detalhe" style="padding:14px 0">Nenhuma pendência nesta competência. Todas as certidões da carteira estão regulares.</p>'
          : `<ul class="pendencias">${pendencias.map(linhaPendencia).join('')}</ul>`
      }
    </div>
  </section>

  ${
    manuais.length > 0
      ? `<section>
    <h2>Conferências manuais (${manuais.length})</h2>
    <div class="cartao">${secaoManual(manuais)}</div>
  </section>`
      : ''
  }

  <section>
    <h2>Situação por cliente</h2>
    <div class="cartao rolagem">
      <table>
        <thead><tr><th scope="col">Cliente</th>${cabecalhos}</tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Legenda</h2>
    <div class="cartao">
      <div class="legenda">
        ${selo('negativa', { curto: false })}
        ${selo('positiva_com_efeito_negativo', { curto: false })}
        ${selo('positiva', { curto: false })}
        ${selo('nao_emitida', { curto: false })}
        ${selo('manual', { curto: false })}
        ${selo('erro', { curto: false })}
        ${selo('nao_aplicavel', { curto: false })}
      </div>
    </div>
  </section>

</div>

<footer class="rodape">
  <div class="folha rodape__interno">
    <p>Cada certidão tem validade própria — CND federal 180 dias, CRF do FGTS 30 dias.
       A data de vencimento aparece na célula quando o órgão a informa. Este relatório
       registra a situação no momento da consulta e não substitui a certidão emitida.</p>
    <span class="assinatura">${SITE}</span>
  </div>
</footer>
</body>
</html>
`;
}
