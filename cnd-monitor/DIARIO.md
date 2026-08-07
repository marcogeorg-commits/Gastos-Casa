# Diário do monitor de certidões

O que foi construído, o que funciona, o que não funciona, e — a parte que mais
importa — **os erros que apareceram no caminho e o que cada um ensinou**.

Escrito para ser lido daqui a seis meses, quando ninguém lembrar por que uma
decisão foi tomada daquele jeito.

---

## 1. O que o programa faz

Consulta as certidões negativas de uma carteira de ~22 clientes (CNPJ e CPF),
mês a mês, e devolve:

| Saída | O que é |
|---|---|
| `certidoes/AAAA-MM/<CNPJ>_<NOME>/` | **as certidões em si**, em PDF |
| `relatorios/AAAA-MM.html` | relatório com semáforo por cliente e por certidão |
| `historico/AAAA-MM.json` | resultado bruto, base da comparação entre meses |

Roda inteiramente na máquina do escritório. Não há servidor, nuvem nem
agendamento remoto — condição imposta pelo uso dos certificados digitais dos
clientes: um `.pfx` mais a senha permitem **assinar como o titular**, e isso não
viaja.

### Certidões atendidas

| Certidão | Órgão | Situação hoje |
|---|---|---|
| CND Federal (RFB/PGFN) | Receita + PGFN | portal público, sem login — **é a principal** |
| CNDT | TST | tem captcha próprio → modo assistido |
| CRF do FGTS | Caixa | seletores nunca calibrados |
| CND Estadual SC | SEF/SC | captcha de imagem visível → manual |
| CADIN Federal | e-CAC | exige certificado digital |
| Situação Fiscal | e-CAC | exige certificado digital |
| CND Municipal | prefeitura | varia por município |

---

## 2. Como está organizado

```
src/
  index.js          linha de comando da consulta
  servidor.js       painel local (127.0.0.1), API e disparo da rodada
  executor.js       percorre cliente × certidão, com fila e intervalo
  catalogo.js       as certidões e as situações possíveis
  config.js         leitura do clientes.json, roteamento por provedor
  situacao.js       interpreta o texto e decide negativa/positiva/...
  receitas/         "onde clicar" de cada portal (seletores)
  provedores/       "como navegar": web, assistido, ecac, mock, ...
  pdf-texto.js      lê o texto de dentro do PDF da certidão
  comprovante.js    guarda o documento emitido
  vigencia.js       não reconsulta o que ainda vale
  cadeia.js         baixa a cadeia de certificação que o portal não manda
  ca-sistema.js     faz o Node confiar nas autoridades do sistema
  diagnostico.js    diário passo a passo de uma consulta
  calibrar.js       inventaria a tela de um portal para ajustar seletores
```

**Provedores** decidem *como* consultar; **receitas** dizem *onde clicar*.
Separados de propósito: um portal muda de layout sem mudar de natureza.

- `web` — automático, sem janela.
- `assistido` — abre janela, a máquina faz tudo menos o captcha.
- `ecac` — autenticado com o certificado digital do cliente.
- `mock` — dados simulados, para desenvolver sem tocar em portal.
- `infosimples` / `serpro` — APIs pagas, com teto de gasto.

Zero dependências no núcleo (Node 22 + biblioteca padrão). Playwright é
dependência **opcional**, só para os provedores que abrem navegador.

---

## 3. Regras de segurança, e por que existem

Não são preferências. Cada uma responde a um estrago concreto.

**O `.pfx` nunca entra no repositório.** Quem tem o arquivo e a senha assume a
identidade fiscal do cliente. Git guarda para sempre: apagar depois não
resolve. `src/certificados.js` **recusa** um certificado que esteja dentro da
pasta do projeto, e o painel avisa em vermelho assim que uma pasta proibida é
digitada.

> Isso virou código porque aconteceu: um `.pfx` de teste foi commitado num
> repositório **público**, com CNPJ de cliente no nome do arquivo. Era um
> arquivo vazio, mas o nome já era vazamento. Documentar "não faça isso" não
> impede que aconteça.

**A senha mora no `.env`, nunca no cadastro.** O `clientes.json` circula: vai
para backup, é aberto numa reunião, é copiado para outra máquina. O painel tem
uma peneira que descarta o campo `senha` mesmo se o navegador o mandar.

**A senha nunca vai como argumento de processo.** `ps` mostra a linha de
comando de qualquer processo para qualquer usuário da máquina. Vai por
descritor de arquivo 3, ou por variável de ambiente do filho.

**O e-CAC recusa rodar em integração contínua.** Verificado em código, não só
documentado: subir 22 certificados de clientes para um runner na nuvem é risco
desproporcional.

**O servidor do painel é desconfiado.** Escuta só em `127.0.0.1`; toda rota de
escrita exige um token sorteado a cada inicialização e injetado na própria
página; confere a origem do pedido; e `.env`, `.git` e as capturas de
calibração **não são servidos** como arquivo estático, ainda que estejam dentro
da pasta.

> Essa última regra existe porque um teste que escrevi encontrou o buraco: o
> `.env` estava sendo servido por HTTP.

**Captcha não se burla.** A proposta de usar serviço de resolução automática
(2captcha) foi recusada, assim como disfarçar o robô para escapar de detecção.
O modo assistido existe justamente para não precisar disso: o captcha exige uma
pessoa, e uma pessoa resolve — a máquina faz todo o resto.

---

## 4. Os erros que apareceram, e o que ensinaram

Esta é a parte útil do documento.

### 4.1 O CNPJ chegava corrompido ao portal

**Sintoma:** o portal respondia *"Não foi possível concluir a ação para o
contribuinte informado. 023"*. A rotina lia isso como portal fora do ar e
tentava de novo três vezes — enquanto o operador emitia a mesma certidão, do
mesmo CNPJ, no navegador, no mesmo minuto.

**Causa:** `pagina.fill()` grava o valor de uma vez. O campo do portal tem
máscara, e **máscara só reage a digitação**: o formulário ficava com o valor
pela metade, sem nada na tela denunciar.

**Correção:** digitar tecla a tecla e — o que faltava — **conferir o que ficou
no campo antes de enviar**. Se não bater, tenta só com dígitos; se ainda não
bater, é erro dito por extenso.

**Lição:** enviar sem conferir o que foi escrito transforma erro de
preenchimento em "o portal está com problema".

### 4.2 Cliente limpo aparecia como devedor

**O erro mais grave de todos.** A regra de classificação procurava a palavra
`pendência` e devolvia `positiva`. Mas o corpo de **toda CND negativa** diz:

> *"é certificado que **não constam pendências** em seu nome"*

Ou seja: o relatório do escritório marcaria de vermelho, como devedor,
justamente o cliente que está limpo.

**Por que não aparecia:** o texto extraído do PDF vinha com as palavras coladas,
e `pendncias` não casava com nada. Era sorte, não acerto. Consertar o
espaçamento desenterrou o erro.

**Correção:** a negação passou a ser avaliada **antes** da palavra que ela nega.

**Lição:** um teste que passa por acidente é pior que um teste que falta — ele
compra confiança que não foi paga.

### 4.3 A certidão era baixada e jogada fora

Quando a leitura da página falhava, a consulta virava erro e o comprovante ia
junto. O programa tinha o documento nas mãos e descartava.

Hoje o comprovante é guardado **sempre que houve download**, mesmo quando a
página não pôde ser lida. E a situação é lida **de dentro do PDF**, que é a
fonte autoritativa: a tela do portal diz só *"emitida com sucesso"*, a mesma
frase para certidão negativa e para positiva com efeito de negativa.

### 4.4 A conexão TLS morria disfarçada de portal fora do ar

**Sintoma no e-CAC:** HTTP 503, título vazio, página de 193 caracteres. Parecia
indisponibilidade.

**Causa real:** o Node não lê o chaveiro do sistema — usa a lista da Mozilla e
só ela. Os portais da Receita são servidos por cadeias da ICP-Brasil. Pior: o
portal manda a cadeia **incompleta**, e o navegador vai atrás do certificado
intermediário que falta (o endereço está escrito dentro do próprio certificado,
no campo *CA Issuers*). O Node não faz essa busca.

**Correção:** `npm run cadeia` faz o que o navegador faria — conecta, pega o que
o servidor apresenta e sobe pelos emissores anunciados até a raiz. O resultado
vai para `ca/` e passa a valer nas conexões seguintes.

**Detalhe deliberado:** o certificado do próprio site fica **fora** da pasta.
Confiar nele individualmente autenticaria aquele servidor sem verificar cadeia
nenhuma — o oposto do que se quer.

### 4.5 "Botões (0)" numa tela cheia de opções

O inventário procurava literalmente pela tag `<button>`. O design system do
gov.br entrega botão como `<a>` estilizado e como `<div role="button">`.

O mesmo defeito apareceu **três vezes**, em lugares diferentes: no inventário do
e-CAC, na calibração, e na barra de cookies — que ficava de pé cobrindo o
rodapé, que é exatamente onde fica o botão *Emitir Certidão*.

**Lição:** "botão" é o que se clica, não a tag.

### 4.6 A tela era examinada antes de existir

Portais de governo montam a página no próprio navegador: o servidor manda uma
casca vazia e o conteúdo aparece quando o script roda. `networkidle` não cobre
isso — portal com chamada em segundo plano nunca fica ocioso, a espera estoura
o prazo em silêncio e a rotina segue olhando a casca.

Sintoma: *"título vazio, zero links"* numa URL que no navegador mostra a tela
inteira.

Variante do mesmo erro, encontrada depois: o campo do hCaptcha entra na página
antes de tudo e **satisfazia a espera sozinho** — o inventário fotografava a
tela ainda vazia.

### 4.7 Correção que vale só para quem entra pela porta certa não é correção

O preparo das autoridades certificadoras estava junto do `launch` do provedor. A
calibração abre navegador próprio e passava direto — então continuou caindo no
mesmo erro que a consulta já tinha resolvido, dias depois de "resolvido".

Hoje mora em `abrirContexto`, o único ponto por onde certificado de cliente
entra. E o teste prende a **ordem**, não só o efeito.

O mesmo padrão apareceu na resolução do certificado: a consulta foi corrigida
para honrar o vínculo escolhido pelo operador, e a **calibração ficou para
trás** adivinhando pelo nome do arquivo. Os `.pfx` do escritório são nomeados
pelo número do pedido, então o palpite nunca acertava — e a mensagem era
"nenhum certificado com este CNPJ no nome", com 23 arquivos na pasta.

### 4.8 Testes que envelheceram pulados

O Chromium nunca estava disponível no ambiente de desenvolvimento, então
`painel.test.js` era sempre pulado — e envelheceu junto com o painel. Quando
finalmente rodou, **seis falhas**: esperava três abas (são cinco), procurava um
botão que foi para trás de uma aba, conferia um rascunho em `localStorage` que o
painel abandonou. Um deles passava por acaso.

Hoje os testes montam o próprio cadastro em pasta temporária, e a suíte roda com
**zero pulados**.

### 4.9 Os comandos não rodavam em caminho com espaço

`import.meta.url` vem percent-encoded; `process.argv[1]` vem cru. Num caminho
como `/Users/marco/LG IA's/Projetos Claude/CND` as duas strings nunca coincidem
— o bloco de entrada não rodava, nada era impresso, e o processo terminava com
**código 0**. A pior falha possível: tem cara de sucesso.

### 4.10 O modo assistido abria sete janelas de uma vez

E as instruções iam para o terminal do servidor, invisível para quem estava
olhando o painel. Hoje há uma fila que garante uma janela por vez, por
construção, e as instruções passam pelo processo que o operador está vendo.

Junto disso: a linha de base que detecta a resposta era capturada **depois** de
digitar. Se a resposta chegasse durante a digitação, ela já nascia dentro da
base, nenhuma mudança aparecia depois, e a consulta voltava como "ninguém agiu"
— com a certidão na tela.

E a janela fechava antes de o operador ler o erro. Corrigido duas vezes: na
primeira, um `return` no meio do caminho pulava a espera.

### 4.11 O "023" era o captcha, e o portal dizia outra coisa

**A investigação mais cara do projeto, resolvida por uma linha de log.**

Durante horas, o portal respondeu:

> *"Não foi possível concluir a ação para o contribuinte informado. Por favor,
> tente novamente dentro de alguns minutos. 023"*

Frase que soa como indisponibilidade. Foi lida como indisponibilidade — e a
rotina passou a tentar três vezes, esperar, e culpar o portal. Pelo caminho,
foram acusados: o certificado digital, a senha, a procuração eletrônica, o menu
do portal, o limite de acesso por IP e a instabilidade do órgão. **Nenhum
deles.**

O `npm run diagnostico` registrou o que a tela não mostra:

```
RESPOSTA COM ERRO: 400 POST /servico/certidoes/api/Emissao/verificar
  corpo: {"statusValidacao":"CaptchaFalhaValidacao","codigo":"023"}
```

**`CaptchaFalhaValidacao`.** O 023 é o hCaptcha reprovando o navegador
automatizado. O portal mostra "tente novamente em alguns minutos" e, por baixo,
diz outra coisa completamente diferente.

No mesmo diário aparece o resto da história: a chave pública do captcha vem de
`/api/env`, os campos `#h-captcha-response-*` existem e ficam **vazios**, e as
requisições do widget do hCaptcha são abortadas — nenhum token é produzido,
então o POST vai sem prova e é recusado.

Isso explica também por que o modo assistido falhou igual: o operador clicou,
mas não havia desafio na tela para resolver. O captcha invisível pontua a
sessão e reprova antes de perguntar qualquer coisa.

**O que mudou no código:** a resposta da API passa a ser lida, e o desfecho diz
a causa com nome — `statusValidacao` e código — em vez de "portal indisponível".
E não repete: insistir não resolve, e cada tentativa é mais uma batida no mesmo
portal.

**O que não vai mudar:** fazer o captcha passar exigiria disfarçar a automação
para não ser reconhecida como automação. É exatamente o que foi recusado quando
surgiu a proposta do 2captcha, e continua recusado. Os caminhos legítimos são
três: emitir no navegador do escritório, usar um provedor com acesso autorizado
(`infosimples` ou `serpro`, já implementados), ou o modo assistido nos portais
cujo captcha de fato apresenta desafio a um humano — CNDT e SEFAZ/SC.

**Lição:** a mensagem que um sistema mostra ao usuário e a que ele registra
internamente podem ser histórias diferentes. Ler só a primeira custou um dia.

---

## 5. Estado atual, sem maquiagem

**Funciona:**

- painel local, cadastro, relatório e histórico;
- leitura do CNPJ de dentro do `.pfx` (o titular vem do certificado, não do nome
  do arquivo);
- aproveitamento do que ainda está vigente;
- guarda do PDF da certidão e leitura da situação de dentro dele;
- cadeia de certificação: o e-CAC carrega (HTTP 200, tela real);
- fila única com intervalo entre consultas.

**Não funciona ainda:**

- **emitir a CND Federal pelo programa.** Causa **estabelecida** (seção 4.11):
  o portal exige hCaptcha e reprova o navegador automatizado. Não é limite de
  IP, não é instabilidade, não é erro interno. Fazer passar significaria
  disfarçar a automação — e isso não será feito.
- login do e-CAC: a tela carrega, mas os passos de entrada ainda não foram
  calibrados contra o portal real;
- FGTS/CRF: seletores nunca calibrados.

**Nunca vai funcionar sem uma pessoa:** SEFAZ/SC (captcha de imagem) e CNDT
(captcha próprio, com campo de resposta e botão "Ouvir"). Para esses, o modo
assistido é o desenho final, não uma etapa.

---

## 6. Como investigar quando der errado

```bash
npm run diagnostico -- --documento 42160865000165
npm run diagnostico -- --documento 42160865000165 --certidao cndt
```

Faz o caminho inteiro narrando cada etapa e guarda tudo em
`diagnostico/<certidao>-<doc>-<data>.log`, com a tela e o HTML ao lado.

O que ele registra e a consulta normal não:

- **cada chamada de rede do portal, com o corpo da resposta** — é aí que mora o
  "023": a página só exibe a frase, quem a produziu foi uma resposta de API que
  ninguém estava lendo;
- erros de JavaScript da própria página, que somem quando a janela fecha;
- o que ficou de fato no campo do documento, depois da máscara;
- o que cada passo de preparação encontrou, clicou, e se sumiu da tela.

O arquivo tem CNPJ de cliente e resposta crua do órgão: fica fora do
versionamento.

### Comandos do dia a dia

```bash
npm start                                    # painel
npm run consultar -- --certidoes rfb_pgfn --provedor web --intervalo 20
npm run consultar -- --certidoes rfb_pgfn --simular      # sem tocar na rede
npm run calibrar -- rfb_pgfn --headed        # inventaria a tela do portal
npm run cadeia                               # baixa cadeias de certificação
npm test
```

---

## 7. O que fazer em seguida

1. **Decidir o caminho da CND Federal**, agora que a causa é conhecida
   (seção 4.11): modo assistido, provedor pago com acesso autorizado
   (`infosimples` / `serpro`, já implementados, com teto de gasto), ou emissão
   no navegador do escritório.
2. Calibrar os passos de login do e-CAC contra o portal real.
3. Calibrar FGTS/CRF, que nunca foi feito.
4. Decidir o que fazer com o repositório `Gastos-Casa`, que é **público**. Nada
   de cliente vazou até hoje — foi verificado — mas o `clientes.json` e os
   certificados dependem do `.gitignore` estar certo, e isso é uma linha de
   defesa só.

---

## 8. Duas coisas para não esquecer

**Se você rodou a carteira antes da correção da seção 4.2, os resultados não
valem.** Clientes limpos podem ter sido marcados como devedores.

**O portal público resolve a CND Federal sem certificado nenhum.** Boa parte do
esforço foi gasta no caminho do e-CAC com certificado digital antes de ficar
claro que a certidão principal sai de uma página com um campo e um botão. O
e-CAC continua valendo — mas só para CADIN e Situação Fiscal, que o portal
público não entrega.
