# cnd-monitor

Consulta mensal das certidões da carteira de clientes (10–20 CNPJs/CPFs) e gera
um relatório HTML visual com semáforo por cliente e por certidão.

O núcleo roda sem dependências: Node 22 e biblioteca padrão. Só o provedor
gratuito `web` acrescenta o Playwright, como dependência opcional.

```bash
cd cnd-monitor
cp clientes.exemplo.json clientes.json   # e substitua pelos dados reais
npm test
npm run consultar                        # usa o provedor "mock" por padrão
```

Saídas:

| Arquivo | Conteúdo |
|---|---|
| `relatorios/AAAA-MM.html` | relatório da competência |
| `relatorios/ultimo.html` | cópia da última execução |
| `historico/AAAA-MM.json` | resultado bruto, para comparação entre meses |

## O que é consultado

| Certidão | Órgão | Fonte automatizável |
|---|---|---|
| CND Federal | Receita Federal / PGFN | SERPRO (oficial), Infosimples ou **`web` (grátis)** |
| CADIN Federal | PGFN / RFB (SISBACEN) | **não há API** — conferência manual (ver abaixo) |
| CRF do FGTS | Caixa | Infosimples ou `web` (provável captcha) |
| CNDT Trabalhista | TST | Infosimples ou `web` (provável captcha) |
| CND Estadual SC | SEF/SC | Infosimples ou `web` (provável captcha) |
| CND Municipal | prefeitura sede | Infosimples (exige `municipio` no cadastro) |

O catálogo fica em `src/catalogo.js`: acrescentar uma certidão é acrescentar uma
entrada lá e um endpoint no provedor.

### Por que o CADIN federal é manual

Não existe API de CADIN federal aberta a empresa privada:

- a API do **Cadin-PGFN no catálogo ConectaGov é restrita a órgãos e entidades da
  administração pública federal**;
- a lei admite consulta por terceiro **munido de documento de identificação e
  procuração legal** — o que, para um escritório contábil, significa o **e-CAC**,
  serviço *"Consulta de Inclusão no CADIN/SISBACEN"*, com o certificado digital do
  escritório e a procuração eletrônica de cada cliente;
- os endpoints "CADIN" de provedores de mercado cobrem os cadastros **estaduais e
  municipais** (SP, PR, MG, RS, Pref. SP), não o federal.

Por isso a rotina marca o CADIN como *conferência manual* e agrupa todos os
clientes numa seção única do relatório, com link para o e-CAC. Ele **não** conta
como pendência — senão todo cliente apareceria em vermelho todo mês.

Na prática, a CND Federal já cobre boa parte do risco: como o CADIN incluído pela
RFB decorre dos mesmos débitos que impedem a certidão, uma CND negativa (ou
positiva com efeito de negativa) é forte indício de ausência de pendência
CADIN-RFB. O CADIN só agrega quando há débito de **outro** órgão federal.

## Provedores

São quatro: `web` (grátis, automação própria), `serpro` e `infosimples` (pagos,
por consulta) e `mock` (simulado, sem rede). O provedor é escolhido no
`clientes.json` e pode variar por certidão — dá para usar o `web` onde ele
funciona e uma API só onde há captcha:

```json
{
  "provedorPadrao": "web",
  "provedores": { "cndt": "infosimples", "fgts_crf": "infosimples" }
}
```

`--provedor <id>` na linha de comando força um provedor para **todas** as
certidões, ignorando os overrides do arquivo — útil para testar.

### `web` — automação própria, sem custo por consulta

Playwright dirigindo o portal público de cada órgão. Não tem credencial nem
mensalidade: o que se paga é em fragilidade.

```bash
npm install playwright && npx playwright install chromium
node src/index.js --provedor web
```

**O captcha é o limite real.** Ele está nesses portais exatamente para impedir
automação, e o provedor não tenta contorná-lo: quando detecta um, a consulta
volta como *conferência manual* com o motivo — nunca como um resultado
inventado. Resolver captcha é boa parte do que se paga num provedor de API.

| Certidão | Expectativa no `web` |
|---|---|
| CND Federal (PJ) | melhor candidato — consulta pública, só CNPJ |
| CND Federal (PF) | recusada: a emissão pede data de nascimento, que não está no cadastro |
| CRF do FGTS, CNDT, SEFAZ/SC | historicamente com captcha — a calibração confirma |

Outras limitações honestas:

- Os seletores em `src/receitas/index.js` **não foram verificados contra os
  portais em produção** — o ambiente onde este código foi escrito não tem acesso
  a eles. Calibre antes de confiar (abaixo).
- Runners do GitHub Actions usam IPs de datacenter, que portais públicos às vezes
  bloqueiam. Se o agendamento falhar por isso, rode o `web` na máquina do
  escritório (ou num runner self-hosted) e deixe o Actions para o provedor de API.
- Quando um seletor não casa ou a resposta não é reconhecível, o resultado é
  `erro` com o texto encontrado — a rotina nunca chuta uma situação.

#### Calibrar os seletores

De uma máquina com acesso aos portais (a sua; nem o ambiente do agente nem os
runners do Actions alcançam esses sites):

```bash
git checkout claude/superpowers-k6v3zw
cd cnd-monitor
npm run preparar-web                  # instala Playwright + Chromium (uma vez)

npm run calibrar -- rfb_pgfn          # lista campos, botões e captcha reais
npm run calibrar -- cndt --headed     # abre o navegador para você acompanhar
```

O comando imprime os seletores que existem de fato, diz quais candidatos da
receita casaram, e salva `calibracao/<certidao>.json` e `.png`.

Esses arquivos **são versionados de propósito** — commite e envie para que os
seletores possam ser ajustados a partir do que o portal realmente tem:

```bash
git add calibracao && git commit -m "Calibração dos portais" && git push
```

### `mock` — padrão, sem rede

Resultado determinístico derivado do documento. Serve para validar cadastro,
relatório e agendamento antes de contratar qualquer API. É o que roda hoje.

### `serpro` — API Consulta CND (fonte oficial)

Consulta o Sistema CND direto nas bases RFB/PGFN, para CNPJ, CPF e NIRF. É a
opção mais confiável: não quebra quando o site muda.

- Contratação na Loja SERPRO, exige **e-CNPJ ICP-Brasil**; cobrança por consumo.
- Autenticação OAuth2: `POST https://gateway.apiserpro.serpro.gov.br/token` com
  `Authorization: Basic base64(consumerKey:consumerSecret)` e
  `grant_type=client_credentials`; o bearer devolvido é reaproveitado entre as
  consultas da rodada.
- Segredos: `SERPRO_CONSUMER_KEY`, `SERPRO_CONSUMER_SECRET`.
- **Confirme o caminho da consulta** no seu contrato e ajuste, se preciso,
  `SERPRO_BASE_URL` e `SERPRO_CAMINHO_CERTIDAO` (o padrão assume
  `…/consulta-cnd/api/v1/certidao/<tipo>/<documento>`). O endpoint do token está
  documentado publicamente; o da consulta varia por versão contratada.
- Cobre **apenas** a CND Federal — é o escopo desse contrato.

### `infosimples` — automação como API

Cobre as demais certidões e devolve o PDF junto. Cadastro rápido, preço por
consulta com desconto por volume.

- Segredo: `INFOSIMPLES_TOKEN`.
- Padrão de chamada: `POST https://api.infosimples.com/api/v2/consulta/<órgão>/<serviço>`,
  com `token` no corpo. A resposta traz `code` / `code_message` / `data` — e vem
  com HTTP 200 mesmo em erro de negócio, então o que vale é o `code`.
- **Slugs**: só `receita-federal/pgfn` está confirmado na documentação pública.
  Os demais (`caixa/regularidade`, `tst/cndt`, `sefaz/sc/cnd`) estão marcados com
  `confirmar: true` em `src/provedores/infosimples.js`. Confira o slug exato no
  painel antes de ativar a certidão, ou sobrescreva sem mexer no código:

  ```
  INFOSIMPLES_ENDPOINTS={"cndt":"tst/cndt","fgts_crf":"caixa/regularidade-fgts"}
  ```

- A CND municipal não tem slug padrão (varia por prefeitura): defina o dela em
  `INFOSIMPLES_ENDPOINTS` quando souber quais municípios a carteira usa.

### Acrescentar um provedor

Um módulo em `src/provedores/` exportando `credenciaisFaltando(credenciais)` e
`consultar({ cliente, certidao, idCertidao, credenciais, env })`, registrado em
`src/provedores/index.js`. O retorno é `{ situacao, detalhe, numeroCertidao,
emitidaEm, validaAte, pdfUrl }`, com `situacao` entre as chaves de `SITUACOES`.

## Cadastro de clientes

```json
{
  "nome": "Alfa Comércio de Alimentos Ltda",
  "documento": "11.222.333/0001-81",
  "municipio": "Blumenau",
  "uf": "SC",
  "certidoes": ["rfb_pgfn", "cndt"],
  "ativo": false
}
```

- `documento` aceita CPF ou CNPJ, com ou sem pontuação. O **CNPJ alfanumérico**
  (IN RFB 2.229/2024) é validado pela regra ASCII-48.
- `certidoes` é opcional — sem ela, valem as da raiz do arquivo.
- `ativo: false` mantém o cliente no cadastro sem consultá-lo.
- Certidões que não se aplicam ao tipo de documento são puladas em silêncio
  (SEFAZ/SC e municipal não valem para CPF).
- Cadastro inválido não derruba a rodada: o cliente é ignorado e vira aviso no
  topo do relatório.

## Execução agendada

`.github/workflows/cnd-mensal.yml` roda **dia 1º às 08:00 (BRT)**, publica o
relatório como artefato e versiona `relatorios/` e `historico/` no repositório.
Também aceita disparo manual (*Run workflow*) com competência e provedor.

Configure os segredos em *Settings → Secrets and variables → Actions*:
`INFOSIMPLES_TOKEN`, `INFOSIMPLES_ENDPOINTS`, `SERPRO_CONSUMER_KEY`,
`SERPRO_CONSUMER_SECRET`. Sem segredo, o provedor correspondente marca as
consultas como falha e diz qual variável falta — a rodada continua.

## Linha de comando

```
node src/index.js [opções]

  --clientes <arquivo>     padrão: clientes.json
  --provedor <id>          força este provedor em todas as certidões
  --competencia <AAAA-MM>  padrão: mês corrente
  --saida <pasta>          padrão: raiz do cnd-monitor
  --concorrencia <n>       consultas simultâneas (padrão 4)
```

Calibração de seletores do provedor `web`:

```
npm run calibrar -- <certidao> [--headed]
```

Falhas de rede são retentadas 3 vezes com backoff exponencial antes de virarem
`erro` no relatório.

## Observações

- `clientes.json` contém CNPJs e CPFs de clientes. O repositório precisa ser
  privado; se for público, mova o arquivo para um segredo e materialize-o no
  passo anterior à consulta.
- Cada certidão tem validade própria (CND federal 180 dias, CRF do FGTS 30 dias).
  Quando o provedor informa a data, ela aparece na célula da matriz.
- O relatório é um HTML autocontido, com tema claro e escuro, pronto para
  imprimir ou anexar em e-mail.
