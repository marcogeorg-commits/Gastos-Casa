# Como o CNPJ é preenchido, sem ponto, barra nem traço

Documento curto, sobre uma coisa só: **por que o programa digita
`42160865000165` e não `42.160.865/0001-65`**, e como ele confere que chegou
inteiro.

---

## O problema que isso resolve

Durante um dia inteiro o portal da Receita respondeu:

> *"Não foi possível concluir a ação para o contribuinte informado. Por favor,
> tente novamente dentro de alguns minutos. 023"*

A frase parecia indisponibilidade. Não era. O portal estava dizendo que **não
reconheceu o documento que recebeu** — e não reconhecia porque o CNPJ chegava
pela metade.

---

## Por que chegava pela metade

O campo do portal tem **máscara**: um pedaço de código que fica ouvindo a
digitação e vai montando a pontuação sozinho, a cada tecla.

```
você digita:  4 2 1 6 0 8 6 5 0 0 0 1 6 5
a máscara faz: 4
               42
               42.1
               42.16
               42.160.8
               ...
               42.160.865/0001-65
```

A automação usava `pagina.fill(campo, valor)`, que **grava o valor de uma vez**,
direto no elemento. É rápido e funciona em campo comum — mas a máscara não vê
digitação nenhuma acontecer. Ela não é chamada. O formulário do Angular fica com
um valor que a máscara nunca processou, e o que sai dali para o servidor é
lixo — ou nada.

**Nada na tela denuncia.** O campo parece preenchido. Só o portal sabe que
recebeu um documento inválido, e ele responde com aquela frase genérica.

---

## O que o programa faz hoje

Três coisas, nesta ordem.

### 1. Manda só os dígitos

```js
formatoDocumento: 'digitos',   // src/receitas/index.js
```

`42160865000165`, sem ponto, sem barra, sem traço.

O motivo é simples: **a máscara põe a pontuação**. Se o valor já chega
formatado, ela recebe separadores que ela mesma ia inserir, e pode duplicá-los
ou rejeitá-los. Foi assim que o operador emitiu no navegador quando funcionou —
copiou e colou os dígitos crus — e é assim que o programa passou a fazer.

### 2. Digita tecla a tecla

```js
await pagina.locator(campo).pressSequentially(valor, { delay: 25 });
```

`pressSequentially` envia **um evento de teclado por caractere**, com 25
milissegundos entre eles. Do ponto de vista da máscara, é indistinguível de uma
pessoa digitando: ela é chamada catorze vezes e monta a pontuação como sempre
monta.

Os 25 ms não são disfarce — são o intervalo que dá tempo de o campo processar
cada tecla antes da seguinte.

### 3. Confere o que ficou lá — e é isto que faltava

```js
const conferir = async () => so(await pagina.inputValue(campo));

if ((await conferir()) === so(documento)) return { ok: true };
```

Lê o campo de volta e compara **só os dígitos** dos dois lados. Se o campo
mostra `42.160.865/0001-65` e o documento é `42160865000165`, ambos viram
`42160865000165` e batem.

Comparar sem pontuação é o que permite aceitar tanto o campo com máscara quanto
o sem.

### 4. Se não bateu, tenta o outro jeito

```js
// A máscara pode rejeitar os separadores que já vieram prontos.
await pagina.fill(campo, '');
await pagina.locator(campo).pressSequentially(so(documento), { delay: 25 });
```

Primeiro tenta com o formato que a receita pediu; se o campo não ficou certo,
limpa e redigita **só com dígitos**. Se ainda assim não bater, devolve erro
dizendo o que ficou no campo:

> `O campo do documento ficou com "4216086" em vez de 42160865000165.`
> `A máscara do portal não aceitou a digitação.`

---

## Por que a conferência importa mais que o resto

Sem ela, um erro de preenchimento vira **"o portal está com problema"**.

A rotina lia o `023` como indisponibilidade, esperava trinta segundos, tentava
de novo, esperava mais, tentava de novo — três vezes contra um portal que não
tinha problema nenhum, enquanto o operador emitia a mesma certidão, do mesmo
CNPJ, no navegador, no mesmo minuto.

Enviar sem conferir o que foi escrito é o que transforma um defeito de dois
caracteres num diagnóstico errado que custa horas.

---

## Onde isso está no código

| O quê | Onde |
|---|---|
| A digitação e a conferência | `src/receitas/index.js` → `escreverDocumento()` |
| A escolha do formato | `src/receitas/index.js` → `formatoDocumento: 'digitos'` |
| Os testes, com campo mascarado de verdade | `test/mascara.test.js` |

O teste monta um campo com máscara em JavaScript — que só reage a `keydown`,
como o do portal — e prova as duas pontas: digitar atravessa, gravar de uma vez
não atravessa, e campo que recusa a digitação vira erro explícito em vez de
"portal indisponível".

---

## E na fila manual, vale o mesmo

Quando o CNPJ vai para a **área de transferência** para você colar no navegador
(`npm run fila`), ele vai igual: **sem pontuação**.

```js
await executar('pbcopy', [], limpar(cliente.documento));
```

Pelo mesmo motivo. Você cola `42160865000165` e a máscara do portal escreve
`42.160.865/0001-65` na sua frente.
