import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Pool } from 'pg';
import { BusService } from '../bus/bus.service';
import { BookingService } from './booking.service';
import type { BookingStore } from './store/booking.store';
import { MemoryBookingStore } from './store/memory.store';
import { PgBookingStore } from './store/pg.store';

/**
 * Las mismas pruebas corren contra los dos almacenes. La de PostgreSQL solo
 * corre si hay TEST_DATABASE_URL (en local: el Postgres de planazo-infra);
 * usa el esquema `booking` de esa base y lo recrea antes de cada prueba.
 */
const PG_URL = process.env.TEST_DATABASE_URL;

const almacenes: Array<[string, () => Promise<BookingStore>]> = [['memoria', async () => new MemoryBookingStore()]];
if (PG_URL) {
  almacenes.push([
    'postgres',
    async () => {
      const pool = new Pool({ connectionString: PG_URL });
      await pool.query('DROP SCHEMA IF EXISTS booking CASCADE');
      await pool.end();
      return new PgBookingStore(PG_URL);
    },
  ]);
}

const cliente = (id: string) => ({ userId: id, role: 'cliente' as const, userName: `Cliente ${id}` });
const negocio = { userId: 'b1', role: 'negocio' as const, placeId: 'p7' };
const nuevoNegocio = (id: string) => ({ userId: id, role: 'negocio' as const, userName: `Dueño ${id}` });

/** Extrae el `code` del cuerpo de una HttpException. */
async function codigoDe(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return ((err as ConflictException).getResponse() as { code?: string }).code;
  }
}

describe.each(almacenes)('BookingService (%s)', (_nombre, crear) => {
  let service: BookingService;
  let store: BookingStore;
  let publish: jest.Mock;

  beforeEach(async () => {
    publish = jest.fn().mockResolvedValue(undefined);
    store = await crear();
    service = new BookingService({ publish } as unknown as BusService, store);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('lista los 43 lugares del seed con sus cupos libres', async () => {
    const places = await service.listPlaces();
    expect(places).toHaveLength(43);
    // Los parques públicos son gratis y sin reserva.
    expect(places.filter((p) => p.category === 'aire-libre' && p.priceLevel === 0)).toHaveLength(7);
    // p7: (8-3) + (8-6) + (8-7) = 8
    expect(places.find((p) => p.id === 'p7')?.freeSeats).toBe(8);
    // Un hotel sin franjas no maneja cupos.
    expect(places.find((p) => p.id === 'p6')?.freeSeats).toBeNull();
  });

  it('filtra por zona y categoría', async () => {
    const bares = await service.listPlaces({ zone: 'zona-t', category: 'bar' });
    expect(bares.map((p) => p.id).sort()).toEqual(['p23', 'p7', 'p8']);
  });

  it('reserva con la versión vigente, sube la versión y publica el inventario', async () => {
    const r = await service.reserve(cliente('u1'), { slotId: 'p7-s1', people: 2, version: 1 });

    expect(r.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(r).toMatchObject({ placeId: 'p7', placeName: 'Bar El Zaguán', startsAt: '19:00', people: 2 });
    const slot = (await service.getPlace('p7')).slots.find((s) => s.id === 'p7-s1')!;
    expect(slot).toMatchObject({ taken: 5, version: 2 });
    expect(await service.myReservations('u1')).toHaveLength(1);

    expect(publish.mock.calls.map((c) => c[0])).toEqual(['INV.UPDATE', 'PLACE.UPDATE', 'RESERVE.OK']);
  });

  it('CC-3: de N reservas simultáneas con la misma versión, gana exactamente una', async () => {
    const usuarios = Array.from({ length: 30 }, (_, i) => `u${i + 1}`);
    const resultados = await Promise.all(
      usuarios.map((u) =>
        service.reserve(cliente(u), { slotId: 'p1-s1', people: 1, version: 1 }).then(
          () => 'OK',
          (e: ConflictException) => (e.getResponse() as { code: string }).code,
        ),
      ),
    );

    expect(resultados.filter((r) => r === 'OK')).toHaveLength(1);
    expect(resultados.filter((r) => r === 'VERSION_CONFLICT')).toHaveLength(29);
    // Solo se descontó un cupo: nada de sobreventa.
    expect((await service.getPlace('p1')).slots[0]).toMatchObject({ taken: 7, version: 2 });
  });

  it('CC-3: reintentando con la versión nueva, nunca se vende más que la capacidad', async () => {
    // p7-s3: capacidad 8, ocupados 7 → queda 1 cupo para 10 personas que insisten.
    const intentar = async (u: string): Promise<string> => {
      for (let i = 0; i < 20; i++) {
        const slot = (await service.getPlace('p7')).slots.find((s) => s.id === 'p7-s3')!;
        if (slot.capacity - slot.taken < 1) return 'LLENO';
        const code = await codigoDe(service.reserve(cliente(u), { slotId: 'p7-s3', people: 1, version: slot.version }));
        if (!code) return 'OK';
        if (code !== 'VERSION_CONFLICT') return code;
      }
      return 'AGOTÓ_REINTENTOS';
    };
    const resultados = await Promise.all(Array.from({ length: 10 }, (_, i) => intentar(`u${i}`)));
    expect(resultados.filter((r) => r === 'OK')).toHaveLength(1);
    const slot = (await service.getPlace('p7')).slots.find((s) => s.id === 'p7-s3')!;
    expect(slot.taken).toBe(8);
  });

  it('cancelar devuelve los cupos, sube la versión y avisa en vivo', async () => {
    const r = await service.reserve(cliente('u1'), { slotId: 'p7-s1', people: 2, version: 1 });
    publish.mockClear();

    await service.cancel({ userId: 'u1', role: 'cliente' }, r.id);

    const slot = (await service.getPlace('p7')).slots.find((s) => s.id === 'p7-s1')!;
    expect(slot).toMatchObject({ taken: 3, version: 3 });
    expect(await service.myReservations('u1')).toHaveLength(0);
    expect(publish.mock.calls.map((c) => c[0])).toEqual(['INV.UPDATE', 'PLACE.UPDATE', 'RESERVE.CANCELLED']);
    expect(publish.mock.calls[2][2]).toEqual(['place:p7', 'user:u1']);
  });

  it('solo cancela quien reservó o el negocio dueño del lugar', async () => {
    const r = await service.reserve(cliente('u1'), { slotId: 'p7-s1', people: 1, version: 1 });
    expect(await codigoDe(service.cancel({ userId: 'u2', role: 'cliente' }, r.id))).toBe('RESERVA_AJENA');
    expect(await codigoDe(service.cancel({ userId: 'b2', role: 'negocio', placeId: 'p1' }, r.id))).toBe('RESERVA_AJENA');
    // b1 administra p7: puede cancelarla desde su panel.
    expect(await codigoDe(service.cancel(negocio, r.id))).toBeUndefined();
    expect(await codigoDe(service.cancel(negocio, r.id))).toBe('RESERVA_NO_EXISTE');
  });

  it('dos cancelaciones simultáneas de la misma reserva liberan los cupos una sola vez', async () => {
    const r = await service.reserve(cliente('u1'), { slotId: 'p7-s1', people: 2, version: 1 });
    const resultados = await Promise.all(
      Array.from({ length: 6 }, () => codigoDe(service.cancel({ userId: 'u1', role: 'cliente' }, r.id))),
    );
    expect(resultados.filter((c) => c === undefined)).toHaveLength(1);
    expect(resultados.filter((c) => c === 'RESERVA_NO_EXISTE')).toHaveLength(5);
    const slot = (await service.getPlace('p7')).slots.find((s) => s.id === 'p7-s1')!;
    expect(slot.taken).toBe(3); // volvió a lo del seed, no menos
  });

  it('rechaza con SIN_CUPO cuando no alcanzan los cupos', async () => {
    // p7-s3: capacidad 8, ocupados 7.
    const code = await codigoDe(service.reserve(cliente('u1'), { slotId: 'p7-s3', people: 2, version: 1 }));
    expect(code).toBe('SIN_CUPO');
  });

  it('panel: la capacidad no baja de lo ya reservado y respeta la versión', async () => {
    expect(
      await codigoDe(service.updateSlotCapacity(negocio, { placeId: 'p7', slotId: 'p7-s2', capacity: 5, version: 1 })),
    ).toBe('CAPACIDAD_MENOR');

    const slot = await service.updateSlotCapacity(negocio, { placeId: 'p7', slotId: 'p7-s2', capacity: 10, version: 1 });
    expect(slot).toMatchObject({ capacity: 10, version: 2 });

    // Un segundo dispositivo con la versión vieja no pisa el cambio.
    expect(
      await codigoDe(service.updateSlotCapacity(negocio, { placeId: 'p7', slotId: 'p7-s2', capacity: 12, version: 1 })),
    ).toBe('VERSION_CONFLICT');
  });

  it('un negocio no puede operar un lugar ajeno', async () => {
    await expect(
      service.updateSlotCapacity(negocio, { placeId: 'p1', slotId: 'p1-s1', capacity: 20, version: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.placeReservations(negocio, 'p1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('publica un evento con cupo máximo en el lugar del negocio', async () => {
    const e = await service.createEvent(negocio, { placeId: 'p7', title: 'Noche de vinilos', startsAt: '21:00', capacity: 30 });
    expect(e).toMatchObject({ placeId: 'p7', capacity: 30, taken: 0 });
    expect((await service.getPlace('p7')).events.map((x) => x.title)).toContain('Noche de vinilos');
  });

  it('un negocio nuevo crea su lugar, queda en el mapa y se anuncia en vivo', async () => {
    const dueño = nuevoNegocio('n-abc12345');
    const p = await service.createPlace(dueño, {
      name: 'La Guarida',
      category: 'bar',
      lat: 4.6668,
      lng: -74.0531,
      priceLevel: 2,
      cover: 'bar-2',
    });

    expect(p).toMatchObject({ name: 'La Guarida', category: 'bar', zone: 'zona-t', cover: 'bar-2', freeSeats: 56 });
    expect((await service.listPlaces()).map((x) => x.id)).toContain(p.id);
    expect((await service.ownedPlace({ ...dueño })).id).toBe(p.id);
    expect((await service.getPlace(p.id)).slots).toHaveLength(3);
    // El dueño nunca sale hacia el cliente.
    expect(JSON.stringify(await service.getPlace(p.id))).not.toContain('n-abc12345');

    const [tipo, payload, topics] = publish.mock.calls.at(-1)!;
    expect(tipo).toBe('PLACE.CREATED');
    expect(payload.place.id).toBe(p.id);
    expect(topics).toEqual(['zone:zona-t', `place:${p.id}`]);

    // Y puede operarlo con su placeId (el gateway se lo pone en el token).
    const slot = await service.updateSlotCapacity(
      { ...dueño, placeId: p.id },
      { placeId: p.id, slotId: `${p.id}-s1`, capacity: 30, version: 1 },
    );
    expect(slot.capacity).toBe(30);
  });

  it('una cuenta de negocio tiene un solo lugar', async () => {
    const dueño = nuevoNegocio('n-dup00001');
    const datos = { name: 'Dos Veces', category: 'restaurante', lat: 4.6555, lng: -74.0565 };
    const resultados = await Promise.all([service.createPlace(dueño, datos), service.createPlace(dueño, datos)].map((p) => codigoDe(p)));
    expect(resultados.filter((c) => c === undefined)).toHaveLength(1);
    expect(resultados.filter((c) => c === 'YA_TIENE_LUGAR')).toHaveLength(1);
  });

  it('no acepta lugares fuera del piloto ni sin nombre', async () => {
    const dueño = nuevoNegocio('n-fuera001');
    expect(await codigoDe(service.createPlace(dueño, { name: 'Lejos', category: 'bar', lat: 4.6, lng: -74.1 }))).toBe(
      'UBICACION_FUERA_DEL_PILOTO',
    );
    expect(await codigoDe(service.createPlace(dueño, { name: 'x', category: 'bar', lat: 4.66, lng: -74.05 }))).toBe(
      'NOMBRE_INVALIDO',
    );
    expect(await codigoDe(service.ownedPlace(dueño))).toBe('SIN_LUGAR');
  });
  describe('cuentas de Google', () => {
    const ana = { googleSub: '1098765432101', email: 'Ana@Gmail.com', name: 'Ana María' };

    it('la primera vez crea la cuenta sin rol; al elegir, el rol queda guardado', async () => {
      const nueva = await service.googleAccount(ana);
      expect(nueva).toMatchObject({ name: 'Ana María', email: 'ana@gmail.com', role: null });
      expect(nueva.accountId).toMatch(/^g[A-Z2-9]{12}$/);

      const conRol = await service.googleAccount({ ...ana, role: 'negocio' });
      expect(conRol).toEqual({ ...nueva, role: 'negocio' });
      expect(await service.googleAccount(ana)).toEqual(conRol);
    });

    it('el rol no cambia aunque el navegador mande otro', async () => {
      await service.googleAccount({ ...ana, role: 'cliente' });
      expect((await service.googleAccount({ ...ana, role: 'negocio' })).role).toBe('cliente');
    });

    it('dos pestañas que entran a la vez terminan en la misma cuenta', async () => {
      const r = await Promise.all(Array.from({ length: 10 }, () => service.googleAccount(ana)));
      expect(new Set(r.map((x) => x.accountId)).size).toBe(1);
    });

    it('sin nombre usa el correo; rechaza identidades o roles inválidos', async () => {
      expect((await service.googleAccount({ googleSub: '55', email: 'luis.p@escuelaing.edu.co', name: '  ' })).name).toBe('luis.p');
      expect(await codigoDe(service.googleAccount({ googleSub: '', email: 'a@b.co' }))).toBe('CUENTA_GOOGLE_INVALIDA');
      expect(await codigoDe(service.googleAccount({ googleSub: '1', email: 'sin-arroba' }))).toBe('CUENTA_GOOGLE_INVALIDA');
      expect(await codigoDe(service.googleAccount({ ...ana, role: 'admin' }))).toBe('ROL_INVALIDO');
    });
  });

  describe('nombres únicos (cuentas)', () => {
    it('el mismo navegador vuelve a entrar con su nombre y conserva su id', async () => {
      const a = await service.claimAccount({ name: 'Juan', deviceId: 'dispositivoA1' });
      expect(a).toEqual({ accountId: 'dispositivoA1', name: 'Juan' });
      expect(await service.claimAccount({ name: '  juan ', deviceId: 'dispositivoA1' })).toEqual(a);
    });

    it('otro navegador no puede usar el mismo nombre, ni con otras mayúsculas o tildes', async () => {
      await service.claimAccount({ name: 'Juan', deviceId: 'dispositivoA1' });
      expect(await codigoDe(service.claimAccount({ name: 'JUÁN', deviceId: 'dispositivoB2' }))).toBe('NOMBRE_EN_USO');
      try {
        await service.claimAccount({ name: 'Juan', deviceId: 'dispositivoB2' });
      } catch (err) {
        expect(((err as ConflictException).getResponse() as { suggestion?: string }).suggestion).toBe('Juan 2');
      }
    });

    it('dos nombres en el mismo navegador son dos cuentas: Juan no hereda el negocio de Pedro', async () => {
      // Pedro crea su negocio con la cuenta del navegador compartido.
      const pedro = await service.claimAccount({ name: 'Pedro', deviceId: 'compartido1' });
      await service.createPlace(
        { userId: `n-${pedro.accountId}`, role: 'negocio', userName: 'Pedro' },
        { name: 'Casa Tequila', category: 'bar', lat: 4.655, lng: -74.056 },
      );
      const juan = await service.claimAccount({ name: 'Juan', deviceId: 'compartido1' });
      expect(juan.accountId).not.toBe(pedro.accountId);
      expect(await codigoDe(service.ownedPlace({ userId: `n-${juan.accountId}`, role: 'negocio' }))).toBe('SIN_LUGAR');
      expect((await service.ownedPlace({ userId: `n-${pedro.accountId}`, role: 'negocio' })).name).toBe('Casa Tequila');
    });

    it('si alguien más entra primero en el navegador del dueño, no recibe su negocio', async () => {
      // Negocio creado antes de las cuentas: dueño n-legado con nombre Pedro.
      await service.createPlace(
        { userId: 'n-legado1234', role: 'negocio', userName: 'Pedro' },
        { name: 'Casa Tequila', category: 'bar', lat: 4.655, lng: -74.056 },
      );
      const juan = await service.claimAccount({ name: 'Juan', deviceId: 'legado1234' });
      expect(juan.accountId).not.toBe('legado1234');
      const pedro = await service.claimAccount({ name: 'pedro', deviceId: 'legado1234' });
      expect(pedro.accountId).toBe('legado1234');
    });

    it('otro nombre en el navegador no hereda las reservas que se hicieron con otro nombre', async () => {
      // Antes de los nombres únicos, «pedro» reservó con el id del navegador.
      const slot = (await service.getPlace('p7')).slots[0];
      await service.reserve({ userId: 'c-navegadorPedro1', role: 'cliente', userName: 'pedro' }, { slotId: slot.id, version: slot.version, people: 2 });

      const pedro2 = await service.claimAccount({ name: 'Pedro 2', deviceId: 'navegadorPedro1' });
      expect(pedro2.accountId).not.toBe('navegadorPedro1');
      expect(await service.myReservations(`c-${pedro2.accountId}`)).toHaveLength(0);

      // Quien sí hizo esas reservas las conserva.
      const pedro = await service.claimAccount({ name: 'pedro', deviceId: 'navegadorPedro1' });
      expect(pedro.accountId).toBe('navegadorPedro1');
      expect(await service.myReservations(`c-${pedro.accountId}`)).toHaveLength(1);
    });

    it('al arrancar, PostgreSQL separa la cuenta que ya había heredado reservas ajenas', async () => {
      if (_nombre !== 'postgres') return;
      const slot = (await service.getPlace('p7')).slots[0];
      await service.reserve({ userId: 'c-heredado123', role: 'cliente', userName: 'pedro' }, { slotId: slot.id, version: slot.version, people: 1 });
      await new Promise((r) => setTimeout(r, 5));
      // Así quedó en producción antes del arreglo: «Pedro 2» con el id del navegador.
      await store.insertAccount({ nameKey: 'pedro 2', name: 'Pedro 2', accountId: 'heredado123', deviceId: 'heredado123' });

      const otra = new PgBookingStore(PG_URL!);
      await otra.init();
      const cuenta = await otra.findAccount('pedro 2');
      expect(cuenta?.accountId).not.toBe('heredado123');
      expect(await otra.reservationsOfUser(`c-${cuenta?.accountId}`)).toHaveLength(0);
      expect(await otra.reservationsOfUser('c-heredado123')).toHaveLength(1);
      await otra.close?.();
    });

    it('treinta navegadores piden «Juan» a la vez: solo uno se lo queda', async () => {
      const r = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) => service.claimAccount({ name: 'Juan', deviceId: `simultaneo${i}xx` })),
      );
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    });

    it('rechaza nombres o dispositivos inválidos', async () => {
      expect(await codigoDe(service.claimAccount({ name: '<b>', deviceId: 'dispositivoA1' }))).toBe('NOMBRE_INVALIDO');
      expect(await codigoDe(service.claimAccount({ name: 'Ana', deviceId: 'x' }))).toBe('DISPOSITIVO_INVALIDO');
    });
  });
});
