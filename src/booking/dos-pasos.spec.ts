import { base32, cifrar, codigoDelPaso, descifrar, desdeBase32, generarSecreto, pasoActual, uriOtpauth, verificarCodigo } from './dos-pasos';

describe('dos pasos (TOTP, RFC 6238)', () => {
  // Vectores oficiales del RFC 6238 (SHA-1, secreto ASCII "12345678901234567890"), 6 dígitos.
  const secretoRfc = base32(Buffer.from('12345678901234567890', 'ascii'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('a los %i s el código es %s', (segundos, esperado) => {
    expect(codigoDelPaso(secretoRfc, Math.floor(segundos / 30))).toBe(esperado);
  });

  it('Base32 ida y vuelta', () => {
    const b = Buffer.from([0, 1, 2, 250, 255, 128, 64]);
    expect(desdeBase32(base32(b)).equals(b)).toBe(true);
    expect(generarSecreto()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('acepta el paso actual y los vecinos (±30 s), no más lejos', () => {
    const s = generarSecreto();
    const ahora = 1_800_000_000_000;
    const p = pasoActual(ahora);
    expect(verificarCodigo(s, codigoDelPaso(s, p), ahora)).toBe(p);
    expect(verificarCodigo(s, codigoDelPaso(s, p - 1), ahora)).toBe(p - 1);
    expect(verificarCodigo(s, codigoDelPaso(s, p + 1), ahora)).toBe(p + 1);
    expect(verificarCodigo(s, codigoDelPaso(s, p + 3), ahora)).toBeNull();
  });

  it('rechaza formatos raros y tolera espacios', () => {
    const s = generarSecreto();
    const ahora = Date.now();
    const c = codigoDelPaso(s, pasoActual(ahora));
    expect(verificarCodigo(s, `${c.slice(0, 3)} ${c.slice(3)}`, ahora)).not.toBeNull();
    expect(verificarCodigo(s, '12345', ahora)).toBeNull();
    expect(verificarCodigo(s, 'abcdef', ahora)).toBeNull();
    expect(verificarCodigo(s, undefined as unknown as string, ahora)).toBeNull();
  });

  it('arma la URI otpauth que leen las apps', () => {
    const u = uriOtpauth('ABCDEF', 'dueño@bar.co');
    expect(u.startsWith('otpauth://totp/Planazo%3Adue%C3%B1o%40bar.co?')).toBe(true);
    expect(u).toContain('secret=ABCDEF');
    expect(u).toContain('issuer=Planazo');
    expect(u).toContain('period=30');
  });

  it('cifra el secreto con AES-GCM: cada vez distinto, y se detecta si lo alteran', () => {
    const a = cifrar('SECRETO');
    expect(a).not.toBe(cifrar('SECRETO'));
    expect(descifrar(a)).toBe('SECRETO');
    const partes = a.split('.');
    partes[3] = Buffer.from('otro').toString('base64url');
    expect(() => descifrar(partes.join('.'))).toThrow();
    expect(() => descifrar('v0.x.y.z')).toThrow();
  });
});
