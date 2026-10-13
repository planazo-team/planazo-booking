/**
 * Nombres únicos. «Juan», «juan» y «Juán» son el mismo nombre: la clave se
 * compara sin mayúsculas, sin tildes y con los espacios colapsados.
 */

/** Letras (con tildes), números, espacios y algo de puntuación; de 2 a 30 caracteres. */
export const NOMBRE = /^[\p{L}\p{N} .'\-_]{2,30}$/u;
/** Identificador del navegador que genera el frontend y guarda en localStorage. */
export const DISPOSITIVO = /^[A-Za-z0-9]{8,40}$/;

export function limpiarNombre(nombre: string): string {
  return String(nombre ?? '').trim().replace(/\s+/g, ' ');
}

export function claveNombre(nombre: string): string {
  return limpiarNombre(nombre)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
