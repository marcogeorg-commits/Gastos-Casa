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
| `historico/AAAA-MM.json` | resultado bruto, base da comparação entre meses |

## Painel

Interface para cadastrar clientes e acompanhar as competências sem editar JSON
na mão:

```bash
npm run painel      # http://localhost:8787
```

- **Clientes** — cadastro com validação de CPF/CNPJ enquanto se digita, escolha
  das certidões por cliente e marcação de ativo/inativo. Certidão que não se
  aplica ao tipo de documento aparece esmaecida; cliente sem lista própria herda
  a da configuração, e o primeiro clique passa a valer só para ele.
- **Situação atual** — matriz cliente × certidão da última execução, com o
  detalhe devolvido pelo órgão no *tooltip*.
- **Competências** — uma linha por execução, com link para cada relatório.

O painel **não grava em disco**: você baixa o `clientes.json` e substitui o
arquivo. Enquanto isso, o rascunho fica no navegador — fechar a aba com
alterações não salvas dispara aviso.

Existe um servidor local porque `file://` bloqueia `fetch` de arquivos vizinhos:
aberto com dois cliques, o painel não conseguiria ler o histórico. Ele serve só
a pasta do `cnd-monitor`, só em `localhost`, e não escreve nada.

### Se o `git pull` reclamar de alterações locais

As execuções gravam em `relatorios/` e `historico/`, e o agendamento no GitHub
Actions versiona os mesmos caminhos. Rodar a mesma competência nos dois lugares
deixa o arquivo local diferente do remoto, e o `git` recusa o merge:

```bash
git checkout -- cnd-monitor/relatorios cnd-monitor/historico
git pull
```

Descartar é seguro: o conteúdo é derivado — basta rodar de novo. Para
experimentar sem tocar nos arquivos versionados, use uma competência própria
(`--competencia teste`) ou outra pasta (`--saida /tmp/cnd`).

## Onde guardar o quê

| Dado | Onde | Por quê |
|---|---|---|
| CNPJ/CPF dos clientes | `clientes.json`, **repositório privado** | a rotina precisa ler; são dados cadastrais, não credenciais |
| Certidões emitidas (PDF) | `certidoes/`, no repositório | é o comprovante que você vai anexar em licitação ou banco |
| Capturas de falha | `calibracao/falha-*`, **fora do versionamento** | mostram tela de consulta real, com dado fiscal |
| Token da Infosimples / chaves SERPRO | **GitHub Secrets** | credencial nunca entra no código |
| **Certificado digital A1 (`.pfx` + senha)** | **nunca no repositório** | quem tem o arquivo e a senha assume a identidade fiscal do cliente |

Sobre o A1: um `.pfx` commitado continua no histórico do Git mesmo depois de
apagado, e qualquer pessoa com acesso ao repositório — hoje ou no futuro — pode
assinar como aquele cliente. Se o CADIN federal entrar na automação (ele exige
e-CAC com certificado e procuração), o caminho é rodar na máquina do escritório,
com o certificado no chaveiro do sistema, e não no GitHub Actions.

## Comparação mês a mês

A partir da segunda execução, o relatório abre com **o que mudou desde a última
competência** — e é essa a informação que justifica uma rotina mensal. Um
relatório sem memória trata igual quem sempre esteve irregular e quem acabou de
ficar; só o segundo caso exige um telefonema hoje.

- Cada certidão é comparada por gravidade, não por igualdade: a transição é
  classificada como **piorou**, **melhorou** ou apenas mudou. Uma falha de
  consulta sobre uma certidão que estava negativa conta como piora — portal fora
  do ar não pode virar boa notícia.
- Entradas e saídas do cadastro viram **uma linha por cliente**, não uma por
  certidão: um cliente novo geraria seis linhas iguais e afogaria as pioras.
- "Anterior" é a última execução que existe, não o mês calendário anterior — se
  a rotina não rodou em algum mês, a comparação continua fazendo sentido.
- Quem não mudou fica fora da seção.

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

## Não existe API gratuita de CND

A **emissão** é gratuita no portal da Receita. A **API**, não: nenhum órgão
publica interface aberta para consulta de CND por empresa privada.

| Caminho | Custo | Confiabilidade |
|---|---|---|
| `web` — automação do portal | zero | frágil: quebra quando o site muda, e o hCaptcha invisível pode barrar |
| SERPRO — API Consulta CND | por consulta, exige e-CNPJ | fonte oficial, a mais sólida |
| Infosimples / FiscalAPI | por consulta ou mensalidade | cobrem também FGTS, CNDT e SEFAZ |

Grátis e "à prova de futuro" são objetivos que se excluem aqui: a única fonte
sem custo é raspagem de portal, e portal público muda sem aviso. Por isso o
provedor é plugável — dá para começar no `web` e trocar por API sem reescrever
nada, quando a fragilidade incomodar.

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

**O captcha é o limite real** — mas nem todo captcha bloqueia. O provedor não
tenta contornar nenhum; ele distingue os dois casos:

- **visível** (caixinha "não sou um robô", imagem com letras): exige interação
  humana. A consulta volta como *conferência manual*, sem tentar.
- **invisível** (hCaptcha/reCAPTCHA v3): não pede nada, pontua o comportamento
  em segundo plano e só desafia sob suspeita. A consulta é tentada; se falhar, o
  relatório registra que a página usa captcha invisível e pode ter barrado.

A distinção é feita por **geometria**: vale se existe na tela um elemento de
captcha visível e com tamanho de desafio. Ler `size=invisible` da URL do iframe
não funciona — o portal da Receita monta vários iframes do hCaptcha, e basta o
primeiro não trazer a marca para o invisível ser classificado como visível e a
consulta ser recusada sem nem tentar.

O portal da Receita usa **hCaptcha invisível** (confirmado na calibração), então
a rota gratuita é tentada — mas só o uso real dirá se ele deixa passar.

| Certidão | Expectativa no `web` |
|---|---|
| CND Federal (PJ) | consulta pública, só CNPJ; hCaptcha **invisível** — tenta e reporta se barrar |
| CND Federal (PF) | funciona se o cadastro tiver `dataNascimento`; sem ela, vira conferência manual |
| CRF do FGTS, CNDT, SEFAZ/SC | historicamente com captcha — a calibração confirma |

O portal de certidões da Receita é um **SPA com rota em hash por tipo de
sujeito**, e a receita escolhe a rota pelo documento do cliente:

| Sujeito | Rota |
|---|---|
| CNPJ | `servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj` |
| CPF | `…/#/home/cpf` |
| Imóvel rural (CIB) | `…/#/home/cib` — **não modelado**: usa identificador próprio |
| Obra de construção civil (CNO) | `…/#/home/cno` — **não modelado**, idem |

Por ser SPA, o formulário só existe depois que o JavaScript renderiza: o
provedor **espera** o campo aparecer em vez de sondar uma vez só. Sondagem
instantânea daria "campo não encontrado" mesmo com a URL certa. E como não há
navegação de página, o sinal de que a consulta terminou é a rota virar
`#/home/<tipo>/resultado`.

#### O desfecho "informações insuficientes"

O portal responde, em parte dos casos:

> As informações disponíveis na Receita Federal e na Procuradoria-Geral da
> Fazenda Nacional sobre o contribuinte X são insuficientes para emitir a
> certidão pela Internet.

Isso significa que **o cliente não tem CND**: há pendência a regularizar antes
de conseguir a certidão. A rotina classifica como `nao_emitida`, conta como
pendência e mostra em vermelho, no mesmo peso de uma certidão positiva. O texto
não traz nenhuma das palavras-chave usuais — sem tratá-lo à parte, o caso que
mais exige atenção viraria "resposta não reconhecida".

Outras limitações honestas:

- Os seletores da **CND Federal foram calibrados** contra o portal real. Os de
  FGTS, CNDT e SEFAZ/SC ainda não — calibre antes de confiar (abaixo).
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
npm run calibrar -- rfb_pgfn --tipo cpf   # calibra a rota de pessoa física
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
  "dataNascimento": "01/01/1980",
  "certidoes": ["rfb_pgfn", "cndt"],
  "ativo": false
}
```

- `documento` aceita CPF ou CNPJ, com ou sem pontuação. O **CNPJ alfanumérico**
  (IN RFB 2.229/2024) é validado pela regra ASCII-48.
- `dataNascimento` (dd/mm/aaaa) só interessa a pessoa física: alguns portais a
  exigem na emissão. Sem ela, a consulta vira conferência manual em vez de erro.
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

### Antes de gastar

```bash
node src/index.js --simular
```

Mostra quantas consultas seriam feitas, por provedor, e quantas são cobradas —
sem tocar na rede. `limiteConsultas` no `clientes.json` aborta a rodada antes de
consultar se o número passar do teto: cadastro duplicado não pode virar fatura.

### Robustez

- Falhas de rede são retentadas 3 vezes com backoff exponencial.
- HTTP **429**, **408** e **5xx** são tratados como transitórios, com novas
  tentativas e respeito ao cabeçalho `Retry-After`. Um pico momentâneo no
  provedor não pode virar "cliente com pendência" no relatório. **401** e
  **404** voltam de imediato — insistir só queima cota.
- Credenciais são **mascaradas** em tudo que sai do processo. O histórico é
  versionado, e uma API que ecoa o token numa mensagem de erro deixaria a
  credencial no Git para sempre.

## Observações

- `clientes.json` contém CNPJs e CPFs de clientes. O repositório precisa ser
  privado; se for público, mova o arquivo para um segredo e materialize-o no
  passo anterior à consulta.
- Cada certidão tem validade própria (CND federal 180 dias, CRF do FGTS 30 dias).
  Quando o provedor informa a data, ela aparece na célula da matriz.
- O relatório é um HTML autocontido, com tema claro e escuro, pronto para
  imprimir ou anexar em e-mail.
