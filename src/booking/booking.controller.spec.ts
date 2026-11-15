import { Test, TestingModule } from '@nestjs/testing';
import type { Request } from 'express';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

describe('BookingController', () => {
  let controller: BookingController;
  let service: jest.Mocked<BookingService>;

  beforeEach(async () => {
    const mockBookingService: Partial<jest.Mocked<BookingService>> = {
      claimAccount: jest.fn(),
      googleAccount: jest.fn(),
      accountById: jest.fn(),
      registerBusiness: jest.fn(),
      listPlaces: jest.fn(),
      createPlace: jest.fn(),
      ownedPlace: jest.fn(),
      getPlace: jest.fn(),
      placeReservations: jest.fn(),
      updateSlotCapacity: jest.fn(),
      reserve: jest.fn(),
      cancel: jest.fn(),
      myReservations: jest.fn(),
      createEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BookingController],
      providers: [
        {
          provide: BookingService,
          useValue: mockBookingService,
        },
      ],
    }).compile();

    controller = module.get<BookingController>(BookingController);
    service = module.get(BookingService);
  });

  it('debe reclamar cuenta', async () => {
    (service.claimAccount as jest.Mock).mockResolvedValueOnce({ ok: true });
    const res = await controller.claimAccount({ name: 'Juan', deviceId: 'dev-12345678' });
    expect(service.claimAccount).toHaveBeenCalledWith({ name: 'Juan', deviceId: 'dev-12345678' });
    expect(res).toEqual({ ok: true });
  });

  it('debe procesar cuenta google', async () => {
    (service.googleAccount as jest.Mock).mockResolvedValueOnce({ ok: true });
    const res = await controller.googleAccount({ googleSub: 'sub-1', email: 'test@example.com' });
    expect(service.googleAccount).toHaveBeenCalledWith({ googleSub: 'sub-1', email: 'test@example.com' });
    expect(res).toEqual({ ok: true });
  });

  it('debe consultar cuenta por id', async () => {
    (service.accountById as jest.Mock).mockResolvedValueOnce({ accountId: 'acc-1' });
    const res = await controller.account('acc-1');
    expect(service.accountById).toHaveBeenCalledWith('acc-1');
    expect(res).toEqual({ accountId: 'acc-1' });
  });

  it('debe registrar negocio', async () => {
    (service.registerBusiness as jest.Mock).mockResolvedValueOnce({ ok: true });
    const res = await controller.registerBusiness('acc-1', { legalName: 'Mi Negocio', nit: '900123456-1' });
    expect(service.registerBusiness).toHaveBeenCalledWith('acc-1', { legalName: 'Mi Negocio', nit: '900123456-1' });
    expect(res).toEqual({ ok: true });
  });

  it('debe listar lugares con filtros', async () => {
    (service.listPlaces as jest.Mock).mockResolvedValueOnce([]);
    const res = await controller.listPlaces('zona-t', 'bar');
    expect(service.listPlaces).toHaveBeenCalledWith({ zone: 'zona-t', category: 'bar' });
    expect(res).toEqual([]);
  });

  it('debe crear lugar decodificando nombre del request', async () => {
    const who = { userId: 'b1', role: 'negocio' as const, placeId: 'p1' };
    const req = { headers: { 'x-user-name': encodeURIComponent('Carlos Pérez') } } as unknown as Request;
    const body = { name: 'Mi Bar', zone: 'zona-t' } as any;

    (service.createPlace as jest.Mock).mockResolvedValueOnce({ id: 'p1' });
    const res = await controller.createPlace(who, req, body);
    expect(service.createPlace).toHaveBeenCalledWith({ ...who, userName: 'Carlos Pérez' }, body);
    expect(res).toEqual({ id: 'p1' });
  });

  it('debe retornar lugar propio', async () => {
    const who = { userId: 'b1', role: 'negocio' as const, placeId: 'p1' };
    (service.ownedPlace as jest.Mock).mockResolvedValueOnce({ id: 'p1' });
    const res = await controller.ownedPlace(who);
    expect(service.ownedPlace).toHaveBeenCalledWith(who);
    expect(res).toEqual({ id: 'p1' });
  });

  it('debe obtener lugar por id', async () => {
    (service.getPlace as jest.Mock).mockResolvedValueOnce({ id: 'p1' });
    const res = await controller.getPlace('p1');
    expect(service.getPlace).toHaveBeenCalledWith('p1');
    expect(res).toEqual({ id: 'p1' });
  });

  it('debe obtener reservas del lugar', async () => {
    const who = { userId: 'b1', role: 'negocio' as const, placeId: 'p1' };
    (service.placeReservations as jest.Mock).mockResolvedValueOnce([]);
    const res = await controller.placeReservations(who, 'p1');
    expect(service.placeReservations).toHaveBeenCalledWith(who, 'p1');
    expect(res).toEqual([]);
  });

  it('debe actualizar capacidad de franja', async () => {
    const who = { userId: 'b1', role: 'negocio' as const, placeId: 'p1' };
    (service.updateSlotCapacity as jest.Mock).mockResolvedValueOnce({ id: 's1' });
    const res = await controller.updateSlot(who, 'p1', 's1', { capacity: 20, version: 1 });
    expect(service.updateSlotCapacity).toHaveBeenCalledWith(who, {
      placeId: 'p1',
      slotId: 's1',
      capacity: 20,
      version: 1,
    });
    expect(res).toEqual({ id: 's1' });
  });

  it('debe realizar reserva', async () => {
    const who = { userId: 'u1', role: 'cliente' as const };
    const req = { headers: {} } as unknown as Request;
    (service.reserve as jest.Mock).mockResolvedValueOnce({ id: 'r1' });
    const res = await controller.reserve(who, req, { slotId: 's1', people: 2, version: 1 });
    expect(service.reserve).toHaveBeenCalledWith({ ...who, userName: 'u1' }, { slotId: 's1', people: 2, version: 1 });
    expect(res).toEqual({ id: 'r1' });
  });

  it('debe cancelar reserva', async () => {
    const who = { userId: 'u1', role: 'cliente' as const };
    (service.cancel as jest.Mock).mockResolvedValueOnce({ ok: true });
    const res = await controller.cancel(who, 'r1');
    expect(service.cancel).toHaveBeenCalledWith(who, 'r1');
    expect(res).toEqual({ ok: true });
  });

  it('debe listar reservas del usuario', async () => {
    const who = { userId: 'u1', role: 'cliente' as const };
    (service.myReservations as jest.Mock).mockResolvedValueOnce([]);
    const res = await controller.myReservations(who);
    expect(service.myReservations).toHaveBeenCalledWith('u1');
    expect(res).toEqual([]);
  });

  it('debe crear evento', async () => {
    const who = { userId: 'b1', role: 'negocio' as const, placeId: 'p1' };
    (service.createEvent as jest.Mock).mockResolvedValueOnce({ id: 'e1' });
    const res = await controller.createEvent(who, {
      placeId: 'p1',
      title: 'Concierto',
      startsAt: '2026-11-20T20:00:00Z',
      capacity: 50,
    });
    expect(service.createEvent).toHaveBeenCalledWith(who, {
      placeId: 'p1',
      title: 'Concierto',
      startsAt: '2026-11-20T20:00:00Z',
      capacity: 50,
    });
    expect(res).toEqual({ id: 'e1' });
  });
});
