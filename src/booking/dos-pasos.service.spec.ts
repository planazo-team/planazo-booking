import type { BusService } from '../bus/bus.service';
import { BookingService } from './booking.service';
import { codigoDelPaso, pasoActual } from './dos-pasos';
import { MemoryBookingStore } from './store/memory.store';

const codigoDe = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const r = (e as { getResponse?: () => { code?: string } }).getResponse?.();
    return r?.code ?? String(e);
  }
};
const statusDe = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { getStatus?: () => number }).getStatus?.();
  }
};
const secretoDe = (uri: string) => new URL(uri).searchParams.get('secret')!;

describe('verificación en dos pasos del modo negocio (ESC-01)', () => {
  let service: BookingService;
  let accountId: string;
  const negocio = { legalName: 'Bar La Telaraña S.A.S.', nit: '900.123.456-8', phone: '310 555 1234', acceptTerms: true };

  beforeEach(async () => {
    service = new BookingService({ publish: jest.fn() } as unknown as BusService, new MemoryBookingStore());
    ({ accountId } = await service.googleAccount({ googleSub: '1098765432101', email: 'dueno@bar.co', name: 'Dueña' }));
  });

  afterEach(() => jest.useRealTimers());

  it('solo una cuenta con negocio registrado puede activarla', async () => {
    expect(await codigoDe(service.iniciarDosPasos(accountId))).toBe('NEGOCIO_NO_REGISTRADO');
    expect(await codigoDe(service.iniciarDosPasos('gNOEXISTE0000'))).toBe('CUENTA_NO_EXISTE');
  });

  it('QR → primer código la activa; la cuenta queda con dosPasos: true', async () => {
    await service.registerBusiness(accountId, negocio);
    expect((await service.accountById(accountId)).dosPasos).toBe(false);
    const { otpauthUri, secreto } = await service.iniciarDosPasos(accountId);
    expect(otpauthUri).toContain('issuer=Planazo');
    expect(secretoDe(otpauthUri)).toBe(secreto);
    expect(await codigoDe(service.confirmarDosPasos(accountId, '000000'))).toBe('2FA_INVALIDO');
    expect(await service.confirmarDosPasos(accountId, codigoDelPaso(secreto, pasoActual(Date.now())))).toEqual({ activo: true });
    expect(await service.estadoDosPasos(accountId)).toEqual({ activo: true });
    expect((await service.accountById(accountId)).dosPasos).toBe(true);
    // Ya activa: no se puede reemplazar el secreto por otro QR.
    expect(await codigoDe(service.iniciarDosPasos(accountId))).toBe('2FA_YA_ACTIVO');
  });

  it('para entrar: acepta el código vigente una sola vez y rechaza el equivocado', async () => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
    await service.registerBusiness(accountId, negocio);
    const { secreto } = await service.iniciarDosPasos(accountId);
    await service.confirmarDosPasos(accountId, codigoDelPaso(secreto, pasoActual(Date.now())));

    jest.setSystemTime(Date.now() + 30_000);
    const vigente = codigoDelPaso(secreto, pasoActual(Date.now()));
    expect(await service.verificarDosPasos(accountId, vigente)).toEqual({ ok: true });
    expect(await codigoDe(service.verificarDosPasos(accountId, vigente))).toBe('2FA_INVALIDO'); // reuso
    expect(await statusDe(service.verificarDosPasos(accountId, '123456'))).toBe(401);
  });

  it('tras 5 códigos equivocados bloquea 5 minutos (429), aun con el código correcto', async () => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
    await service.registerBusiness(accountId, negocio);
    const { secreto } = await service.iniciarDosPasos(accountId);
    await service.confirmarDosPasos(accountId, codigoDelPaso(secreto, pasoActual(Date.now())));
    jest.setSystemTime(Date.now() + 60_000);
    for (let i = 0; i < 4; i++) expect(await codigoDe(service.verificarDosPasos(accountId, '000000'))).toBe('2FA_INVALIDO');
    expect(await statusDe(service.verificarDosPasos(accountId, '000000'))).toBe(429);
    const bueno = codigoDelPaso(secreto, pasoActual(Date.now()));
    expect(await codigoDe(service.verificarDosPasos(accountId, bueno))).toBe('2FA_BLOQUEADO');
    jest.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    expect(await service.verificarDosPasos(accountId, codigoDelPaso(secreto, pasoActual(Date.now())))).toEqual({ ok: true });
  });

  it('verificar sin tenerla activa responde 2FA_NO_ACTIVO', async () => {
    expect(await codigoDe(service.verificarDosPasos(accountId, '123456'))).toBe('2FA_NO_ACTIVO');
    await service.registerBusiness(accountId, negocio);
    await service.iniciarDosPasos(accountId);
    expect(await codigoDe(service.verificarDosPasos(accountId, '123456'))).toBe('2FA_NO_ACTIVO');
    expect(await codigoDe(service.confirmarDosPasos('gNOEXISTE0000', '1'))).toBe('CUENTA_NO_EXISTE');
  });

  it('confirmar sin haber pedido el QR responde 2FA_NO_INICIADO', async () => {
    await service.registerBusiness(accountId, negocio);
    expect(await codigoDe(service.confirmarDosPasos(accountId, '123456'))).toBe('2FA_NO_INICIADO');
  });
});
