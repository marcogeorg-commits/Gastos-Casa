/**
 * Normalizacao e validacao de CPF e CNPJ.
 *
 * O CNPJ alfanumerico (IN RFB 2.229/2024, em vigor desde 2026) usa os mesmos
 * pesos do calculo classico, porem o valor de cada caractere e o codigo ASCII
 * menos 48 -- de modo que os digitos 0-9 continuam valendo 0-9.
 */

const PESOS_CPF_1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CPF_2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** Remove pontuacao e normaliza para maiusculas. */
export function limpar(documento) {
  return String(documento ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

/** Retorna 'cpf', 'cnpj' ou null, apenas pelo formato. */
export function tipoDocumento(documento) {
  const bruto = limpar(documento);
  if (/^\d{11}$/.test(bruto)) return 'cpf';
  if (/^[0-9A-Z]{12}\d{2}$/.test(bruto)) return 'cnpj';
  return null;
}

function digitoVerificador(valores, pesos) {
  const soma = valores.reduce((acc, valor, i) => acc + valor * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function validarCpf(documento) {
  const bruto = limpar(documento);
  if (!/^\d{11}$/.test(bruto)) return false;
  if (/^(\d)\1{10}$/.test(bruto)) return false;

  const digitos = bruto.split('').map(Number);
  const dv1 = digitoVerificador(digitos.slice(0, 9), PESOS_CPF_1);
  const dv2 = digitoVerificador(digitos.slice(0, 10), PESOS_CPF_2);
  return dv1 === digitos[9] && dv2 === digitos[10];
}

export function validarCnpj(documento) {
  const bruto = limpar(documento);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(bruto)) return false;
  if (/^(\d)\1{13}$/.test(bruto)) return false;

  const valores = bruto.split('').map((c) => c.charCodeAt(0) - 48);
  const dv1 = digitoVerificador(valores.slice(0, 12), PESOS_CNPJ_1);
  const dv2 = digitoVerificador(valores.slice(0, 13), PESOS_CNPJ_2);
  return dv1 === valores[12] && dv2 === valores[13];
}

export function validar(documento) {
  const tipo = tipoDocumento(documento);
  if (tipo === 'cpf') return validarCpf(documento);
  if (tipo === 'cnpj') return validarCnpj(documento);
  return false;
}

/** Formata para exibicao: 00.000.000/0000-00 ou 000.000.000-00. */
export function formatar(documento) {
  const bruto = limpar(documento);
  const tipo = tipoDocumento(bruto);
  if (tipo === 'cpf') {
    return bruto.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  }
  if (tipo === 'cnpj') {
    return bruto.replace(
      /^([0-9A-Z]{2})([0-9A-Z]{3})([0-9A-Z]{3})([0-9A-Z]{4})(\d{2})$/,
      '$1.$2.$3/$4-$5',
    );
  }
  return bruto;
}
