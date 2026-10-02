import { ConflictException, ForbiddenException } from '@nestjs/common';
import { BusService } from '../bus/bus.service';
import { BookingService } from './booking.service';

function nuevoServicio() {
  const bus = { publish: jest.fn().mockResolvedValue(undefined) } as unknown as BusService;
  return { service: new BookingService(bus), bus };
}

const cliente = (id: string) => ({ userId: id, role: 'cliente' as const, userName: `Cliente ${id}` });
const negocio = { userId: 'b1', role: 'negocio' as const, placeId: 'p7' };

/** Extrae el `code` del cuerpo de una HttpException. */
async function codigoDe(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return ((err as ConflictException).getResponse() as { code?: string }).code;
  }
}

describe('BookingService', () => {
  it('lista los 12 lugares del seed con sus cupos libres', () => {
    const { service } = nuevoServicio();
    const places = service.listPlaces();
    expect(places).toHaveLength(12);
    // p7: (8-3) + (8-6) + (8-7) = 8
    expect(places.find((p) => p.id === 'p7')?.freeSeats).toBe(8);
    // Un hotel sin franjas no maneja cupos.
    expect(places.find((p) => p.id === 'p6')?.freeSeats).toBeNull();
  });

  it('filtra por zona y categoría', () => {
    const { service } = nuevoServicio();
    const bares = service.listPlaces({ zone: 'zona-t', category: 'bar' });
    expect(bares.map((p) => p.id).sort()).toEqual(['p7', 'p8']);
  });

  it('reserva con la versión vigente, sube la versión y publica el inventario', async () => {
    const { service, bus } = nuevoServicio();
    const r = await service.reserve(cliente('u1'), { slotId: 'p7-s1', people: 2, version: 1 });

    expect(r.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    const slot = service.getPlace('p7').slots.find((s) => s.id === 'p7-s1')!;
    expect(slot).toMatchObject({ taken: 5, version: 2 });
    expect(service.myReservations('u1')).toHaveLength(1);

    const tipos = (bus.publish as jest.Mock).mock.calls.map((c) => c[0]);
    expect(tipos).toEqual(['INV.UPDATE', 'PLACE.UPDATE', 'RESERVE.OK']);
  });

  it('CC-3: de N reservas simultáneas con la misma versión, gana exactamente una', async () => {
    const { service } = nuevoServicio();
    const intentos = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((u) =>
      service.reserve(cliente(u), { slotId: 'p1-s1', people: 1, version: 1 }).then(
        () => 'OK',
        (e: ConflictException) => (e.getResponse() as { code: string }).code,
      ),
    );
    const resultados = await Promise.all(intentos);

    expect(resultados.filter((r) => r === 'OK')).toHaveLength(1);
    expect(resultados.filter((r) => r === 'VERSION_CONFLICT')).toHaveLength(5);
    // Solo se descontó un cupo: nada de sobreventa.
    expect(service.getPlace('p1').slots[0]).toMatchObject({ taken: 7, version: 2 });
  });

  it('rechaza con SIN_CUPO cuando no alcanzan los cupos', async () => {
    const { service } = nuevoServicio();
    // p7-s3: capacidad 8, ocupados 7.
    const code = await codigoDe(service.reserve(cliente('u1'), { slotId: 'p7-s3', people: 2, version: 1 }));
    expect(code).toBe('SIN_CUPO');
  });

  it('panel: la capacidad no baja de lo ya reservado y respeta la versión', async () => {
    const { service } = nuevoServicio();
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
    const { service } = nuevoServicio();
    await expect(
      service.updateSlotCapacity(negocio, { placeId: 'p1', slotId: 'p1-s1', capacity: 20, version: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(() => service.placeReservations(negocio, 'p1')).toThrow(ForbiddenException);
  });

  it('publica un evento con cupo máximo en el lugar del negocio', async () => {
    const { service } = nuevoServicio();
    const e = await service.createEvent(negocio, { placeId: 'p7', title: 'Noche de vinilos', startsAt: '21:00', capacity: 30 });
    expect(e).toMatchObject({ placeId: 'p7', capacity: 30, taken: 0 });
    expect(service.getPlace('p7').events.map((x) => x.title)).toContain('Noche de vinilos');
  });
});
