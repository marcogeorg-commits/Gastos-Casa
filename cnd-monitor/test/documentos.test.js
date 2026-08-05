import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatar, tipoDocumento, validar, validarCnpj, validarCpf } from '../src/documentos.js';

test('reconhece o tipo pelo formato', () => {
  assert.equal(tipoDocumento('123.456.780-62'), 'cpf');
  assert.equal(tipoDocumento('11.222.333/0001-81'), 'cnpj');
  assert.equal(tipoDocumento('12345'), null);
});

test('valida CPF pelo digito verificador', () => {
  assert.ok(validarCpf('123.456.780-62'));
  assert.ok(!validarCpf('123.456.780-63'));
  assert.ok(!validarCpf('111.111.111-11'), 'sequencia repetida e invalida');
});

test('valida CNPJ numerico', () => {
  assert.ok(validarCnpj('11.222.333/0001-81'));
  assert.ok(!validarCnpj('11.222.333/0001-82'));
});

test('valida CNPJ alfanumerico usando ASCII-48', () => {
  // Base alfanumerica '12ABC34501DE' -- DV calculado pela mesma regra da IN 2.229/2024.
  const base = '12ABC34501DE';
  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const dv = (valores, pesos) => {
    const resto = valores.reduce((a, v, i) => a + v * pesos[i], 0) % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const valores = base.split('').map((c) => c.charCodeAt(0) - 48);
  const d1 = dv(valores, pesos1);
  const d2 = dv([...valores, d1], pesos2);

  assert.ok(validarCnpj(`${base}${d1}${d2}`));
  assert.ok(!validarCnpj(`${base}${d1}${(d2 + 1) % 10}`));
});

test('formata para exibicao', () => {
  assert.equal(formatar('12345678062'), '123.456.780-62');
  assert.equal(formatar('11222333000181'), '11.222.333/0001-81');
});

test('validar despacha pelo tipo', () => {
  assert.ok(validar('11.222.333/0001-81'));
  assert.ok(!validar('nao-e-documento'));
});
