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

/** Id de cuenta de Google que asigna booking: «g» y 12 caracteres. */
export const CUENTA_GOOGLE = /^g[A-Z2-9]{12}$/;

/** Versión de los términos para negocios que se acepta al registrarse. */
export const TERMINOS_NEGOCIO = 'negocios-v1-2026-11';

/**
 * Dígito de verificación del NIT según la DIAN: cada dígito de la base, de
 * derecha a izquierda, se multiplica por 3, 7, 13, 17, 19, 23, 29, 37, 41, 43,
 * 47, 53, 59, 67 y 71; si el residuo de la suma entre 11 es 0 o 1, ese es el
 * dígito; si no, es 11 menos el residuo.
 */
export function digitoVerificacion(base: string): number {
  const pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  let suma = 0;
  for (let i = 0; i < base.length; i++) suma += Number(base[base.length - 1 - i]) * pesos[i];
  const r = suma % 11;
  return r > 1 ? 11 - r : r;
}

/**
 * Valida un NIT con su dígito de verificación («900.123.456-8», «9001234568»)
 * y lo devuelve normalizado (solo dígitos), o `null` si no es válido. La base
 * tiene de 6 a 10 dígitos (cédulas y NIT de personas jurídicas).
 */
export function nitValido(nit: string): string | null {
  const m = String(nit ?? '').replace(/[\s.]/g, '').match(/^(\d{6,10})-?(\d)$/);
  if (!m || /^0/.test(m[1])) return null;
  return digitoVerificacion(m[1]) === Number(m[2]) ? `${m[1]}${m[2]}` : null;
}

/** Celular (3xx…) o fijo (60x…) colombiano, con o sin +57. Devuelve «+57…» o `null`. */
export function telefonoValido(tel: string): string | null {
  const t = String(tel ?? '').replace(/[\s\-()]/g, '').replace(/^\+?57(?=\d{10}$)/, '');
  return /^(3\d{9}|60\d{8})$/.test(t) ? `+57${t}` : null;
}

/** Razón social: de 3 a 120 caracteres, sin caracteres de control ni etiquetas. */
export function razonSocialValida(nombre: string): string | null {
  const n = String(nombre ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().replace(/\s+/g, ' ');
  return n.length >= 3 && n.length <= 120 && !/[<>]/.test(n) ? n : null;
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
