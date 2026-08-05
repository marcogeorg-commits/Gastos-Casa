import { CATALOGO, descreverSituacao } from './catalogo.js';

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

function competenciaPorExtenso(competencia) {
  const [ano, mes] = competencia.split('-').map(Number);
  return `${MESES[mes - 1]} de ${ano}`;
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
          <p class="pend__detalhe">${esc(item.detalhe ?? s.rotulo)}</p>
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

export function gerarHtml({ competencia, execucao, config }) {
  const { resultados, resumo, avisos, geradoEm } = execucao;
  const clientes = agruparPorCliente(resultados);
  const colunas = config.certidoesAtivas.filter((id) =>
    resultados.some((r) => r.certidao === id),
  );

  const pendencias = resultados
    .filter((r) => descreverSituacao(r.situacao).pendencia)
    .sort((a, b) => a.cliente.localeCompare(b.cliente, 'pt-BR'));

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
          return `<td class="celula" title="${esc(item.detalhe ?? '')}">${selo(item.situacao)}${
            item.validaAte ? `<span class="celula__validade">vence ${esc(dataCurta(item.validaAte))}</span>` : ''
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
<style>
  :root {
    color-scheme: light dark;
    --plano: #f9f9f7;
    --surface: #fcfcfb;
    --ink: #0b0b0b;
    --ink-2: #52514e;
    --ink-mudo: #898781;
    --linha: #e1e0d9;
    --borda: rgba(11, 11, 11, 0.10);
    --good: #0ca30c;
    --warning: #fab219;
    --serious: #ec835a;
    --critical: #d03b3b;
    --lavagem: rgba(11, 11, 11, 0.035);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --plano: #0d0d0d;
      --surface: #1a1a19;
      --ink: #ffffff;
      --ink-2: #c3c2b7;
      --ink-mudo: #898781;
      --linha: #2c2c2a;
      --borda: rgba(255, 255, 255, 0.10);
      --lavagem: rgba(255, 255, 255, 0.045);
    }
  }
  :root[data-theme="dark"] {
    --plano: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --ink-mudo: #898781;
    --linha: #2c2c2a;
    --borda: rgba(255, 255, 255, 0.10);
    --lavagem: rgba(255, 255, 255, 0.045);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px 64px;
    background: var(--plano);
    color: var(--ink);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .folha { max-width: 1100px; margin: 0 auto; }

  header { margin-bottom: 28px; }
  h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.01em; }
  .sub { margin: 0; color: var(--ink-2); font-size: 15px; }
  .meta { margin-top: 6px; color: var(--ink-mudo); font-size: 13px; }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 28px;
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--borda);
    border-radius: 10px;
    padding: 16px 18px;
  }
  .tile__valor { font-size: 34px; font-weight: 600; line-height: 1.1; }
  .tile--good .tile__valor { color: var(--good); }
  .tile--critical .tile__valor { color: var(--critical); }
  .tile__rotulo { margin-top: 6px; font-size: 14px; color: var(--ink-2); }
  .tile__apoio { margin-top: 2px; font-size: 12px; color: var(--ink-mudo); }

  section { margin-bottom: 28px; }
  h2 { font-size: 17px; margin: 0 0 12px; }
  .cartao {
    background: var(--surface);
    border: 1px solid var(--borda);
    border-radius: 10px;
    padding: 4px 18px;
  }

  .selo {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    color: var(--ink);
  }
  .selo__icone { font-size: 12px; line-height: 1; }
  .selo--good .selo__icone { color: var(--good); }
  .selo--warning .selo__icone { color: var(--warning); }
  .selo--serious .selo__icone { color: var(--serious); }
  .selo--critical .selo__icone { color: var(--critical); }
  .selo--neutro { color: var(--ink-mudo); }

  .avisos { list-style: none; margin: 0; padding: 14px 0; }
  .avisos li {
    display: flex; gap: 8px; padding: 4px 0;
    font-size: 14px; color: var(--ink-2);
  }
  .avisos li::before { content: "▲"; color: var(--warning); font-size: 11px; line-height: 1.6; }

  .pendencias { list-style: none; margin: 0; padding: 0; }
  .pend { padding: 16px 0; border-bottom: 1px solid var(--linha); }
  .pend:last-child { border-bottom: 0; }
  .pend__topo { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
  .pend__cliente { font-weight: 600; }
  .pend__doc { color: var(--ink-mudo); font-size: 13px; font-variant-numeric: tabular-nums; }
  .pend__certidao { margin-top: 2px; font-size: 13px; color: var(--ink-2); }
  .pend__detalhe { margin: 6px 0 0; font-size: 14px; color: var(--ink-2); }
  .pend__link { font-size: 13px; color: var(--ink-2); }

  .manual { padding: 16px 0; border-bottom: 1px solid var(--linha); }
  .manual:last-child { border-bottom: 0; }
  .fichas { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 8px; }
  .ficha {
    font-size: 12px; color: var(--ink-2);
    border: 1px solid var(--borda); border-radius: 999px; padding: 3px 10px;
  }

  .rolagem { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  thead th {
    text-align: left; padding: 10px 12px; vertical-align: bottom;
    border-bottom: 1px solid var(--linha); font-weight: 600;
  }
  .col__nome { display: block; }
  .col__orgao { display: block; font-weight: 400; font-size: 11px; color: var(--ink-mudo); }
  tbody tr:nth-child(even) { background: var(--lavagem); }
  .celula, .celula-cliente { padding: 10px 12px; vertical-align: top; }
  .celula-cliente { text-align: left; font-weight: 500; }
  .celula-cliente__nome { display: block; }
  .celula-cliente__doc {
    display: block; font-weight: 400; font-size: 12px;
    color: var(--ink-mudo); font-variant-numeric: tabular-nums;
  }
  .celula__validade {
    display: block; margin-top: 2px; font-size: 11px;
    color: var(--ink-mudo); font-variant-numeric: tabular-nums;
  }

  .legenda { display: flex; flex-wrap: wrap; gap: 16px; padding: 14px 0; }
  footer { color: var(--ink-mudo); font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
<div class="folha">
  <header>
    <h1>Monitor de Certidões</h1>
    <p class="sub">Competência ${esc(competenciaPorExtenso(competencia))} · ${resumo.clientes} clientes na carteira</p>
    <p class="meta">Gerado em ${esc(dataHora(geradoEm))} · provedor padrão: ${esc(config.provedorPadrao)}</p>
  </header>

  <div class="tiles">
    ${tile(resumo.clientes, 'Clientes monitorados', `${colunas.length} certidões por cliente`)}
    ${tile(regulares, 'Certidões regulares', `de ${resumo.consultas} consultas`, 'good')}
    ${tile(
      resumo.clientesComPendencia,
      'Clientes com débito ou falha',
      `${pendencias.length} itens abertos`,
      statusGeral,
    )}
    ${tile(manuais.length, 'Conferências manuais', 'sem API disponível')}
  </div>

  ${
    avisos.length > 0
      ? `<section>
    <h2>Avisos de cadastro e configuração</h2>
    <div class="cartao"><ul class="avisos">${avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>
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

  <footer>
    Relatório gerado por cnd-monitor. Cada certidão tem validade própria (CND federal 180 dias,
    CRF do FGTS 30 dias) — a data de vencimento aparece na célula quando o provedor a informa.
  </footer>
</div>
</body>
</html>
`;
}
