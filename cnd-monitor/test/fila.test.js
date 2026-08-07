import test from 'node:test';
import assert from 'node:assert/strict';

import { portalDe, prepararCliente, quemFalta } from '../src/fila.js';
import { chaveDe } from '../src/vigencia.js';

const CONFIG = {
  certidoes: ['rfb_pgfn', 'cndt'],
  clientes: [
    { nome: 'Alfa', documento: '11222333000181', tipo: 'cnpj' },
    { nome: 'Beta', documento: '22333444000181', tipo: 'cnpj' },
    { nome: 'Gama (baixada)', documento: '33444555000181', tipo: 'cnpj', ativo: false },
    { nome: 'João', documento: '12345678062', tipo: 'cpf', certidoes: ['rfb_pgfn'] },
    { nome: 'Delta (só CNDT)', documento: '44555666000181', tipo: 'cnpj', certidoes: ['cndt'] },
  ],
};

/**
 * Uma CND federal vale 180 dias.
 *
 * Pedir de novo o que ainda vale gasta um gesto humano à toa — e é essa conta
 * que transforma "vinte e duas emissões por mês" em "vinte e duas por
 * semestre". Num fluxo onde cada emissão custa três gestos de uma pessoa, essa
 * é a economia que importa.
 */
test('quem já tem certidão vigente fica de fora da fila', () => {
  const vigentes = new Map([
    [chaveDe('11222333000181', 'rfb_pgfn'), { validaAte: '31/12/2027', diasRestantes: 200 }],
  ]);

  const fila = quemFalta(CONFIG, 'rfb_pgfn', vigentes);
  const nomes = fila.map((c) => c.nome);

  assert.ok(!nomes.includes('Alfa'), 'Alfa tem certidão vigente');
  assert.ok(nomes.includes('Beta'));
  assert.ok(nomes.includes('João'), 'CPF também entra');

  // Cliente baixado não se consulta.
  assert.ok(!nomes.includes('Gama (baixada)'));
  // E quem não pediu esta certidão também não.
  assert.ok(!nomes.includes('Delta (só CNDT)'));
});

test('--forcar traz de volta quem já tem vigente', () => {
  const vigentes = new Map([
    [chaveDe('11222333000181', 'rfb_pgfn'), { validaAte: '31/12/2027', diasRestantes: 200 }],
  ]);

  const fila = quemFalta(CONFIG, 'rfb_pgfn', vigentes, { forcar: true });
  assert.ok(fila.map((c) => c.nome).includes('Alfa'));
});

test('cada certidão tem o seu portal, e o CPF tem a rota dele', () => {
  assert.match(portalDe('rfb_pgfn', 'cnpj'), /#\/home\/cnpj$/);
  assert.match(portalDe('rfb_pgfn', 'cpf'), /#\/home\/cpf$/);
  // Portal sem rota por tipo cai na única que existe.
  assert.match(portalDe('cndt', 'cpf'), /cndt-certidao\.tst\.jus\.br/);
  assert.equal(portalDe('nao_existe'), null);
});

/**
 * O CNPJ vai para a área de transferência **sem pontuação**.
 *
 * É assim que o operador emitiu no navegador quando funcionou, e a máscara do
 * campo põe a pontuação sozinha. Colar já formatado faz a máscara receber
 * separadores que ela mesma ia inserir — o mesmo erro que corrompia o CNPJ na
 * automação.
 */
test('o documento vai limpo para a área de transferência, e o portal abre', async () => {
  const chamadas = [];
  const executar = async (comando, args, entrada) => {
    chamadas.push({ comando, args, entrada });
    return true;
  };

  const copiado = await prepararCliente(
    { nome: 'Alfa', documento: '11.222.333/0001-81', tipo: 'cnpj' },
    'https://portal.exemplo/#/home/cnpj',
    executar,
  );

  assert.equal(copiado, '11222333000181');
  assert.deepEqual(chamadas[0], { comando: 'pbcopy', args: [], entrada: '11222333000181' });
  assert.equal(chamadas[1].comando, 'open');
  assert.deepEqual(chamadas[1].args, ['https://portal.exemplo/#/home/cnpj']);
});

test('sem portal conhecido, ainda assim copia o documento', async () => {
  const chamadas = [];
  const executar = async (comando) => {
    chamadas.push(comando);
    return true;
  };

  await prepararCliente({ nome: 'X', documento: '11222333000181' }, null, executar);

  // Copiar sozinho já vale: o operador abre o portal como preferir.
  assert.deepEqual(chamadas, ['pbcopy']);
});
