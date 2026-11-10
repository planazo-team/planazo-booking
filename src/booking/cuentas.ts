/**
 * Nombres únicos. «Juan», «juan» y «Juán» son el mismo nombre: la clave se
 * compara sin mayúsculas, sin tildes y con los espacios colapsados.
 */

/** Letras (con tildes), números, espacios y algo de puntuación; de 2 a 30 caracteres. */
export const NOMBRE = /^[\p{L}\p{N} .'\-_]{2,30}$/u;
/** Identificador del navegador que genera el frontend y guarda en localStorage. */
export const DISPOSITIVO = /^[A-Za-z0-9]{8,40}$/;

/** El `sub` de Google: hasta 255 caracteres ASCII visibles (en la práctica, dígitos). */
export const GOOGLE_SUB = /^[!-~]{1,255}$/;
export const CORREO = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/**
 * El nombre que trae Google, limpio: sin caracteres de control y de máximo
 * 60 caracteres. Si viene vacío se usa la parte del correo antes de la @.
 */
export function nombreDeGoogle(nombre: string, correo: string): string {
  const limpio = String(nombre ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim();
  return limpio || correo.split('@')[0].slice(0, 60);
}

export function limpiarNombre(nombre: string): string {
  return String(nombre ?? '').trim().replace(/\s+/g, ' ');
}

export function claveNombre(nombre: string): string {
  return limpiarNombre(nombre)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
