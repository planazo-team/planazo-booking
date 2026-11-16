import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Verificación en dos pasos con app autenticadora (TOTP, RFC 6238), sin
 * dependencias. Se usa para entrar en modo negocio (ESC-01: autenticación
 * multifactor para acciones sensibles).
 *
 * - Secreto de 20 bytes (160 bits), en Base32 para la app.
 * - HMAC-SHA1, pasos de 30 s, 6 dígitos (lo que leen Google y Microsoft Authenticator).
 * - Se acepta el paso anterior y el siguiente (±30 s de reloj).
 * - En la base el secreto va cifrado con AES-256-GCM.
 */

export const PASO_SEG = 30;
export const DIGITOS = 6;
export const VENTANA = 1;
export const EMISOR = 'Planazo';

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Buffer): string {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const b of bytes) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO[(valor << (5 - bits)) & 31];
  return salida;
}

export function desdeBase32(texto: string): Buffer {
  const limpio = texto.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let valor = 0;
  const salida: number[] = [];
  for (const c of limpio) {
    valor = (valor << 5) | ALFABETO.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      salida.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(salida);
}

/** Un secreto nuevo, en Base32. */
export function generarSecreto(): string {
  return base32(randomBytes(20));
}

/** El código de 6 dígitos de un paso (contador) dado. RFC 4226 + RFC 6238. */
export function codigoDelPaso(secretoBase32: string, contador: number): string {
  const mensaje = Buffer.alloc(8);
  mensaje.writeBigUInt64BE(BigInt(contador));
  const hmac = createHmac('sha1', desdeBase32(secretoBase32)).update(mensaje).digest();
  const desplazamiento = hmac[hmac.length - 1] & 0x0f;
  const binario = (hmac.readUInt32BE(desplazamiento) & 0x7fffffff) % 10 ** DIGITOS;
  return String(binario).padStart(DIGITOS, '0');
}

export const pasoActual = (ahoraMs: number) => Math.floor(ahoraMs / 1000 / PASO_SEG);

/** Comparación en tiempo constante de dos códigos de igual largo. */
function iguales(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

/**
 * Busca el código en la ventana ±VENTANA alrededor de `ahoraMs`.
 * @returns el contador (paso) que coincidió, o `null`.
 */
export function verificarCodigo(secretoBase32: string, codigo: string, ahoraMs: number): number | null {
  const limpio = String(codigo ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(limpio)) return null;
  const actual = pasoActual(ahoraMs);
  for (let d = -VENTANA; d <= VENTANA; d++) {
    if (iguales(codigoDelPaso(secretoBase32, actual + d), limpio)) return actual + d;
  }
  return null;
}

/** URI que la app autenticadora lee del QR. */
export function uriOtpauth(secretoBase32: string, cuenta: string): string {
  const etiqueta = encodeURIComponent(`${EMISOR}:${cuenta}`);
  const q = new URLSearchParams({ secret: secretoBase32, issuer: EMISOR, algorithm: 'SHA1', digits: String(DIGITOS), period: String(PASO_SEG) });
  return `otpauth://totp/${etiqueta}?${q.toString()}`;
}

/** Llave de cifrado del secreto: TOTP_KEY si existe; si no, derivada de GATEWAY_KEY. */
function llave(): Buffer {
  const base = process.env.TOTP_KEY || process.env.GATEWAY_KEY || 'solo-desarrollo-local';
  return createHash('sha256').update(`planazo-2fa:${base}`).digest();
}

/** AES-256-GCM: `v1.<iv>.<tag>.<cifrado>` en base64url. */
export function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', llave(), iv);
  const cifrado = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), cifrado.toString('base64url')].join('.');
}

export function descifrar(guardado: string): string {
  const [version, iv, tag, cifrado] = guardado.split('.');
  if (version !== 'v1' || !iv || !tag || !cifrado) throw new Error('Secreto 2FA con formato desconocido');
  const d = createDecipheriv('aes-256-gcm', llave(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(cifrado, 'base64url')), d.final()]).toString('utf8');
}
