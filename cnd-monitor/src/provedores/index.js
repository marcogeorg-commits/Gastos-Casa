import * as mock from './mock.js';
import * as infosimples from './infosimples.js';
import * as serpro from './serpro.js';

export const PROVEDORES = { mock, infosimples, serpro };

export function obterProvedor(id) {
  const provedor = PROVEDORES[id];
  if (!provedor) {
    throw new Error(
      `Provedor desconhecido: "${id}". Disponiveis: ${Object.keys(PROVEDORES).join(', ')}.`,
    );
  }
  return provedor;
}
