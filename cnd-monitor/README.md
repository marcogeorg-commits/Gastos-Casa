# cnd-monitor

Consulta mensal das certidões da carteira de clientes (10–20 CNPJs/CPFs) e gera
um relatório HTML visual com semáforo por cliente e por certidão.

O núcleo roda sem dependências: Node 22 e biblioteca padrão. Só o provedor
gratuito `web` acrescenta o Playwright, como dependência opcional.

```bash
cd cnd-monitor
npm start          # abre http://localhost:8787 no navegador
```

É só isso. O painel cadastra os clientes, dispara a consulta e mostra o
resultado — nenhum JSON editado à mão, nenhum comando decorado.

**Tudo roda nesta máquina.** Não há servidor, nuvem nem agendamento remoto. É
essa a condição para usar os certificados digitais dos clientes: um `.pfx` mais
a senha permitem assinar como o titular, e isso não deve viajar.

Saídas:

| Arquivo | Conteúdo |
|---|---|
| `certidoes/AAAA-MM/<CNPJ>_<NOME>/` | **as certidões em si**, uma pasta por cliente |
| `relatorios/AAAA-MM.html` | relatório da competência, com o timbre da casa |
| `relatorios/ultimo.html` | cópia da última execução |
| `historico/AAAA-MM.json` | resultado bruto, base da comparação entre meses |

## Painel

Quatro abas, em `http://localhost:8787`:

- **Situação** — matriz cliente × certidão da última rodada, com o que o órgão
  respondeu no *tooltip*, e os indicadores do mês.
- **Clientes** — cadastro com validação de CPF/CNPJ enquanto se digita, escolha
  das certidões por cliente e marcação de ativo/inativo. Certidão que não se
  aplica ao tipo de documento aparece esmaecida; cliente sem lista própria herda
  a da configuração, e o primeiro clique passa a valer só para ele.
- **Certificados** — associa o `.pfx` de cada cliente e diz, sem mostrar senha
  nenhuma, quais senhas ainda faltam no `.env`.
- **Competências** — uma linha por execução, com link para cada relatório.

O botão **Consultar agora** roda a rotina como processo separado e transmite a
saída ao vivo. Fechar a aba não interrompe: ao reabrir, o painel reencontra a
rodada em andamento.

As alterações do cadastro são **gravadas direto em `clientes.json`**, com a
versão anterior guardada em `historico/clientes.anterior.json`.

### Por que existe um servidor local

Aberto com dois cliques (`file://`), o painel não conseguiria ler o histórico
nem gravar o cadastro. O servidor resolve isso — e, como agora ele escreve
arquivo e executa processo, foi construído desconfiado:

- escuta só em `127.0.0.1`, nunca na rede;
- toda rota de escrita exige um token sorteado a cada inicialização, que o
  servidor injeta na própria página — outra aba do navegador não o tem;
- confere a origem do pedido, para uma página aberta ao lado não conseguir
  mandar apagar o cadastro;
- `.env`, `.git` e as capturas de calibração **não são servidos** como arquivo
  estático, ainda que estejam dentro da pasta;
- devolve se a senha existe, nunca a senha.

## Onde guardar o quê

| Dado | Onde | Por quê |
|---|---|---|
| CNPJ/CPF dos clientes | `clientes.json`, nesta máquina | a rotina precisa ler; são dados cadastrais, não credenciais |
| Certidões emitidas (PDF) | `certidoes/` | é o comprovante que você vai anexar em licitação ou banco |
| Capturas de falha | `calibracao/falha-*`, **fora do versionamento** | mostram tela de consulta real, com dado fiscal |
| **Certificado digital A1 (`.pfx`)** | **pasta sua, fora do projeto** | quem tem o arquivo e a senha assume a identidade fiscal do cliente |
| **Senha do certificado** | `.env`, ignorado pelo Git | separada do `.pfx`: um vazamento sozinho não assina nada |

### Onde fica cada coisa no disco

O programa e os certificados moram na mesma pasta do escritório, mas em
compartimentos separados — lado a lado, nunca um dentro do outro:

```
CND/                         a pasta do escritório
├── cnd-monitor/             o programa
│   ├── clientes.json        cadastro (fora do versionamento)
│   ├── .env                 senhas   (fora do versionamento)
│   └── relatorios/          saídas   (fora do versionamento)
└── Certificados/            os .pfx  — FORA do projeto
```

O padrão de fábrica é `../Certificados`, que é exatamente essa pasta irmã.
Caminho relativo se resolve a partir da pasta do programa, não de onde você
chamou o comando — a mesma configuração funciona vindo de qualquer terminal.

Espaço e apóstrofo no caminho funcionam — `/Users/…/LG IA's/Projetos Claude/CND`
é um caso testado. Isso não era verdade até a versão que introduziu
`src/executavel.js`: os três comandos (`start`, `consultar`, `calibrar`)
terminavam em silêncio, com código 0, num caminho com espaço.

`src/certificados.js` **recusa** um certificado que esteja dentro de
`cnd-monitor/`, e o painel avisa em vermelho assim que você digita uma pasta
proibida. Não é preciosismo: um `.pfx` commitado continua no histórico do Git
mesmo depois de apagado, e qualquer pessoa com acesso ao repositório — hoje ou
daqui a cinco anos — pode assinar como aquele cliente.

### O certificado e a senha

O painel, na aba **Certificados**, guarda apenas duas coisas no cadastro: o
**nome do arquivo** e o **nome da variável** que carrega a senha. A senha em si
nunca passa pelo navegador nem entra em `clientes.json`.

```bash
cp .env.exemplo .env       # o Git ignora .env
# uma linha por cliente:
# CERT_ALFA_COMERCIO=senha-do-certificado
```

O painel lista exatamente quais variáveis ainda faltam e oferece as linhas
prontas para colar. O arquivo é ajustado para `0600` — legível só pelo seu
usuário — a cada inicialização.

Se um dia este projeto for para o GitHub, o repositório precisa ser **privado**:
o `clientes.json` tem CNPJ e CPF de terceiros.

## O documento, não só a notícia

O relatório diz que a certidão está negativa; o que você anexa numa licitação ou
manda para o banco é o PDF. Toda consulta bem-sucedida guarda o comprovante em
`certidoes/AAAA-MM/<CNPJ>_<RAZÃO SOCIAL>/`, e o link aparece na célula do
relatório e do painel.

Cada portal entrega de um jeito, então a captura tenta em ordem: o arquivo que o
portal baixou (o CNDT faz assim), a página impressa em PDF (a Receita mostra a
certidão como página), e por último a tela mais o HTML. O terceiro caso não é
desistência — `page.pdf()` só funciona em Chromium sem janela, e o modo assistido
roda com janela de propósito; a captura de tela ainda prova o que foi consultado
e quando.

Ficar sem o arquivo nunca derruba a consulta: saber que o cliente está irregular
vale mesmo sem o papel.

## Não reconsultar o que ainda vale

Uma CND federal vale 180 dias; a CRF do FGTS, 30. Antes de consultar, a rotina lê
o histórico e aproveita o que ainda está vigente, com folga de 20 dias antes do
vencimento. No modo assistido isso é o que separa "um captcha por certidão por
mês" de "só os que venceram" — a CND federal passa a pedir captcha uma vez por
semestre.

O resultado aproveitado aparece como **Vigente**, não como "Negativa": o dado é
da consulta anterior e o relatório não pode dar a entender que foi verificado
hoje. `--forcar` ignora o aproveitamento.

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
| CADIN Federal | PGFN / RFB (SISBACEN) | **`ecac` (grátis)** — exige certificado digital |
| Situação Fiscal | Receita Federal (e-CAC) | **`ecac` (grátis)** — exige certificado digital |
| CRF do FGTS | Caixa | Infosimples ou `web` (provável captcha) |
| CNDT Trabalhista | TST | Infosimples ou `web` (provável captcha) |
| CND Estadual SC | SEF/SC | Infosimples ou `web` (provável captcha) |
| CND Municipal | prefeitura sede | Infosimples (exige `municipio` no cadastro) |

O catálogo fica em `src/catalogo.js`: acrescentar uma certidão é acrescentar uma
entrada lá e um endpoint no provedor.

## e-CAC com certificado digital

Com o certificado A1 do cliente (ou procuração eletrônica dele para o
escritório), o provedor `ecac` alcança o que nenhum portal público entrega:

| Consulta | O que traz |
|---|---|
| **CADIN Federal** | o único caminho legítimo para empresa privada |
| **Situação Fiscal** | todas as pendências do contribuinte — mais detalhado que a própria CND |

```json
{
  "certificados": { "pastaPadrao": "../Certificados" },
  "provedores": { "cadin_federal": "ecac", "situacao_fiscal": "ecac" },
  "clientes": [
    {
      "nome": "Alfa Comércio Ltda",
      "documento": "11.222.333/0001-81",
      "certificado": { "arquivo": "alfa.pfx", "senhaVariavel": "CERT_ALFA" }
    }
  ]
}
```

A senha **nunca** entra no cadastro: vem da variável de ambiente nomeada em
`senhaVariavel`. O cadastro com senha escrita é recusado.

Cada cliente é consultado num contexto próprio do navegador — é onde o
Playwright prende o certificado, e misturá-los faria um cliente ser consultado
com a credencial de outro.

### O que este módulo recusa, e por quê

Um `.pfx` mais a senha permitem **assinar como o cliente**. Por isso:

- **Certificado dentro do repositório é recusado.** Commitado uma vez, fica no
  histórico do Git para sempre, ao alcance de quem tiver acesso hoje ou daqui a
  cinco anos.
- **Senha no cadastro é recusada.** O `clientes.json` circula: vai para backup,
  é aberto por engano numa reunião, é copiado para outra máquina. Senha ali é
  senha em texto aberto, e a peneira do painel a descarta mesmo se enviada.
- **Sessão não autenticada é detectada** antes de ler qualquer coisa: sem essa
  checagem, o texto da tela de login viraria "resultado" no relatório.

Rode o `ecac` na máquina do escritório, com os certificados numa pasta fora do
projeto. O provedor **recusa rodar em integração contínua** (`CI` ou
`GITHUB_ACTIONS` no ambiente): subir 20 certificados de clientes para um runner
na nuvem é risco desproporcional ao problema que resolve, e documentar "não faça
isso" não impede que aconteça.

### Uma consulta de cada vez, com respiro

Vinte e dois clientes disparados em sequência, sem pausa, é o que faz um portal
público responder "tente novamente dentro de alguns minutos" — e a partir daí a
rodada inteira se perde, não só a consulta que passou do limite.

```bash
npm run consultar -- --certidoes rfb_pgfn --provedor web --intervalo 20
```

`--intervalo` implica fila única: espalhar a espera entre consultas paralelas
devolveria a rajada que ela existe para evitar. A pausa vem **entre** uma e a
seguinte, nunca antes da primeira, e varia até 40% para cima — cadência exata é
o que um portal mede para se defender de volume. A contagem aparece na tela,
porque minuto de silêncio parece travamento e a primeira reação é interromper a
rodada no meio.

Também dá pelo ambiente, para valer em toda rodada: `INTERVALO_CONSULTAS=20000`.

### "No navegador abre e aqui não"

Se a consulta parar com **"Esta máquina não reconhece a cadeia de certificação
do portal"** — ou, no log, `unable to verify the first certificate` numa página
de 193 caracteres com HTTP 503 —, não é o certificado do cliente, nem a senha,
nem procuração. É a cadeia do **servidor**.

Quando um portal manda a cadeia incompleta, o navegador vai atrás do
certificado intermediário que falta: o endereço está escrito dentro do próprio
certificado, no campo *CA Issuers*. O Node não faz essa busca. Daí a diferença.

```bash
npm run cadeia                    # os portais do login do e-CAC
npm run cadeia -- outro.gov.br    # qualquer outro
```

O comando faz o que o navegador faria e guarda o resultado em `ca/`. Tudo que
estiver nessa pasta passa a valer nas conexões seguintes, junto com o chaveiro
do sistema — o certificado do próprio site fica de fora de propósito, porque
confiar nele individualmente autenticaria aquele servidor sem verificar cadeia
nenhuma.

### Por que o CADIN federal era manual

Não existe API de CADIN federal aberta a empresa privada:

- a API do **Cadin-PGFN no catálogo ConectaGov é restrita a órgãos e entidades da
  administração pública federal**;
- a lei admite consulta por terceiro **munido de documento de identificação e
  procuração legal** — o que, para um escritório contábil, significa o **e-CAC**,
  serviço *"Consulta de Inclusão no CADIN/SISBACEN"*, com o certificado digital do
  escritório e a procuração eletrônica de cada cliente;
- os endpoints "CADIN" de provedores de mercado cobrem os cadastros **estaduais e
  municipais** (SP, PR, MG, RS, Pref. SP), não o federal.

Sem certificado, a rotina marca o CADIN como *conferência manual* e agrupa todos
os clientes numa seção única do relatório, com link para o e-CAC. Ele **não**
conta como pendência — senão todo cliente apareceria em vermelho todo mês. Com
certificado, o provedor `ecac` resolve.

Na prática, a CND Federal já cobre boa parte do risco: como o CADIN incluído pela
RFB decorre dos mesmos débitos que impedem a certidão, uma CND negativa (ou
positiva com efeito de negativa) é forte indício de ausência de pendência
CADIN-RFB. O CADIN só agrega quando há débito de **outro** órgão federal.

## Não existe API gratuita de CND

A **emissão** é gratuita no portal da Receita. A **API**, não: nenhum órgão
publica interface aberta para consulta de CND por empresa privada.

| Caminho | Custo | Confiabilidade |
|---|---|---|
| `web` — automação do portal | zero | frágil; na CND Federal o hCaptcha **barrou** em teste real |
| `ecac` — certificado do cliente | zero | cobre CADIN e Situação Fiscal; exige certificado e cuidado com ele |
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

O portal da Receita usa **hCaptcha invisível**, e em consulta real ele **deixou
a automação passar**: o formulário foi preenchido e enviado normalmente. Não há
garantia de que siga assim — o escore do hCaptcha pode mudar de comportamento a
qualquer momento, e é isso que se compra ao contratar uma API.

| Certidão | Expectativa no `web` |
|---|---|
| CND Federal (PJ) | **funciona**: o hCaptcha invisível não barrou em consulta real |
| CND Federal (PF) | funciona se o cadastro tiver `dataNascimento`; sem ela, vira conferência manual |
| **CND Federal** | **barrado**: o hCaptcha invisível recusou a automação em teste real, embora a consulta manual funcione |
| **SEFAZ/SC** | **não automatizável**: captcha de imagem visível ("Digite o texto") |
| CRF do FGTS, CNDT | provável captcha — a calibração confirma |

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

#### O portal pisca: erro 023

Em consulta real o portal respondeu:

> Não foi possível concluir a ação para o contribuinte informado. Por favor,
> tente novamente dentro de alguns minutos. **023**

Isso não é informação sobre o cliente — é o sistema fora do ar. A rotina
reconhece a mensagem, **espera e tenta de novo** (3 vezes, 30s entre elas, ajustável
por `WEB_TENTATIVAS_PORTAL` e `WEB_ESPERA_PORTAL`). Persistindo, o resultado é
`indisponivel`, com rótulo próprio: a certidão continua faltando, mas ninguém
lê isso como débito de uma empresa regular.

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
- Portais públicos às vezes bloqueiam IPs de datacenter. Rodando na máquina do
  escritório — que é como este projeto funciona — o problema não se apresenta.
- Quando um seletor não casa ou a resposta não é reconhecível, o resultado é
  `erro` com o texto encontrado — a rotina nunca chuta uma situação.

#### Calibrar os seletores

Da sua máquina, que é a única com acesso aos portais (o ambiente do agente não
alcança esses sites):

```bash
cd ~/Gastos-Casa/cnd-monitor          # os comandos abaixo dependem desta pasta
npm run preparar-web                  # instala Playwright + Chromium (uma vez)

npm run calibrar -- rfb_pgfn          # lista campos, botões e captcha reais
npm run calibrar -- rfb_pgfn --tipo cpf   # calibra a rota de pessoa física
npm run calibrar -- cndt --headed     # abre o navegador para você acompanhar

# e-CAC: entra com o certificado de um cliente e inventaria a tela autenticada
npm run calibrar -- cadin_federal --cliente "Alfa"
```

A calibração do e-CAC salva a captura como `calibracao/ecac-*.png`, **fora do
versionamento**: ela mostra a tela autenticada de um cliente.

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

## Repetir todo mês

Não há agendamento automático, de propósito: a consulta pode precisar do
certificado digital e de um navegador visível, e uma tarefa que dispara sozinha
com essas duas coisas é pior que um lembrete.

Abra o painel no primeiro dia útil do mês e clique em **Consultar agora**. Se
quiser um empurrão, um lembrete no calendário resolve. Para agendar mesmo assim
na sua máquina (`launchd` no macOS, `cron` no Linux), o comando é:

```bash
cd ~/Gastos-Casa/cnd-monitor && npm run consultar
```

Ele lê o `.env` sozinho, então as senhas dos certificados funcionam mesmo fora
do seu terminal.

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
