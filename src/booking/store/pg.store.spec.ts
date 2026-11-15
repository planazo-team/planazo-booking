import { Pool } from 'pg';
import { PgBookingStore } from './pg.store';

jest.mock('pg', () => {
  const mClient = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
  const mPool = {
    connect: jest.fn().mockResolvedValue(mClient),
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  };
  return {
    Pool: jest.fn(() => mPool),
  };
});

describe('PgBookingStore', () => {
  let store: PgBookingStore;
  const mockedPool = Pool as unknown as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new PgBookingStore('postgres://localhost:5432/test');
  });

  it('debe inicializar esquema y seed con advisory lock', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    const client = await poolInstance.connect();
    client.query.mockResolvedValueOnce({ rows: [{ c: 0 }] });

    await store.init();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_lock'));
  });

  it('debe listar lugares con filtros', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    poolInstance.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'p1',
          name: 'Bar 1',
          category: 'bar',
          zone: 'zona-t',
          lat: 4.6,
          lng: -74.0,
          description: 'Desc',
          price_level: 2,
          cover: null,
          created_at: 1000,
          owner_id: 'b1',
          owner_name: 'Dueño',
          free: 5,
        },
      ],
    });

    const places = await store.listPlaces({ zone: 'zona-t', category: 'bar' });
    expect(places).toHaveLength(1);
    expect(places[0].id).toBe('p1');
  });

  it('debe obtener un lugar por id o retornar null', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    poolInstance.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'p1',
          name: 'Bar 1',
          category: 'bar',
          zone: 'zona-t',
          lat: 4.6,
          lng: -74.0,
          description: '',
          price_level: 2,
          cover: null,
          created_at: 1000,
          owner_id: 'b1',
          owner_name: 'Dueño',
        },
      ],
    });

    const place = await store.getPlace('p1');
    expect(place).toBeDefined();
    expect(place?.id).toBe('p1');

    poolInstance.query.mockResolvedValueOnce({ rows: [] });
    const nullPlace = await store.getPlace('inexistente');
    expect(nullPlace).toBeNull();
  });

  it('debe obtener lugar de un dueño (placeOwnedBy)', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    poolInstance.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'p1',
          name: 'Bar 1',
          category: 'bar',
          zone: 'zona-t',
          lat: 4.6,
          lng: -74.0,
          description: '',
          price_level: 2,
          cover: null,
          created_at: 1000,
          owner_id: 'b1',
          owner_name: 'Dueño',
        },
      ],
    });

    const place = await store.placeOwnedBy('b1');
    expect(place?.id).toBe('p1');
  });

  it('debe obtener cupos libres (freeSeats)', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    poolInstance.query.mockResolvedValueOnce({
      rows: [{ n: 1, free: 8 }],
    });

    const libre = await store.freeSeats('p1');
    expect(libre).toBe(8);
  });

  it('debe obtener franjas y eventos de un lugar', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    poolInstance.query.mockResolvedValueOnce({
      rows: [{ id: 's1', place_id: 'p1', starts_at: '20:00', capacity: 10, taken: 0, version: 1 }],
    });

    const slots = await store.slotsOf('p1');
    expect(slots).toHaveLength(1);

    poolInstance.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', place_id: 'p1', title: 'Concierto', starts_at: '21:00', capacity: 50, taken: 0 }],
    });
    const events = await store.eventsOf('p1');
    expect(events).toHaveLength(1);
  });

  it('debe obtener slot por id', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    poolInstance.query.mockResolvedValueOnce({
      rows: [{ id: 's1', place_id: 'p1', starts_at: '20:00', capacity: 10, taken: 0, version: 1 }],
    });
    const slot = await store.getSlot('s1');
    expect(slot?.id).toBe('s1');
  });

  it('debe crear lugar y franjas con transacción', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    const client = await poolInstance.connect();

    await store.createPlace(
      {
        id: 'p2',
        name: 'Bar 2',
        category: 'bar',
        zone: 'zona-g',
        lat: 4.6,
        lng: -74.0,
        description: '',
        priceLevel: 1,
        cover: null,
        ownerId: 'b2',
      },
      [{ id: 's2', placeId: 'p2', startsAt: '20:00', capacity: 15, taken: 0, version: 1 }],
    );

    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('debe crear un evento', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    await store.createEvent({ id: 'e2', placeId: 'p1', title: 'Fiesta', startsAt: '22:00', capacity: 30, taken: 0 });
    expect(poolInstance.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO booking.events'),
      ['e2', 'p1', 'Fiesta', '22:00', 30, 0],
    );
  });

  it('debe ejecutar reserve con éxito', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    const client = await poolInstance.connect();
    client.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
    client.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 's1', place_id: 'p1', starts_at: '20:00', capacity: 10, taken: 2, version: 2 }],
    }); // UPDATE slot
    client.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: 'r1',
          slot_id: 's1',
          place_id: 'p1',
          place_name: 'Bar 1',
          starts_at: '20:00',
          people: 2,
          code: 'RES-1',
          user_id: 'u1',
          user_name: 'Carlos',
          created_at: 1000,
        },
      ],
    }); // INSERT reservation
    client.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await store.reserve(
      { slotId: 's1', version: 1, people: 2 },
      { id: 'r1', code: 'RES-1', userId: 'u1', userName: 'Carlos', createdAt: 1000 },
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.reservation.id).toBe('r1');
    }
  });

  it('debe manejar fallo de reserve si la versión no coincide', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    const client = await poolInstance.connect();
    client.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
    client.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // UPDATE no matched
    client.query.mockResolvedValueOnce({
      rows: [{ id: 's1', place_id: 'p1', starts_at: '20:00', capacity: 10, taken: 10, version: 3 }],
    }); // SELECT current slot
    client.query.mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await store.reserve(
      { slotId: 's1', version: 1, people: 2 },
      { id: 'r1', code: 'RES-1', userId: 'u1', userName: 'Carlos', createdAt: 1000 },
    );

    expect(res.ok).toBe(false);
  });

  it('debe actualizar capacidad de franja con updateCapacity', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    poolInstance.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 's1', place_id: 'p1', starts_at: '20:00', capacity: 20, taken: 5, version: 2 }],
    });

    const res = await store.updateCapacity({ slotId: 's1', version: 1, capacity: 20 });
    expect(res.ok).toBe(true);
  });

  it('debe cancelar reserva con cancel', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    const client = await poolInstance.connect();
    client.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
    client.query.mockResolvedValueOnce({
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          code: 'RES-1',
          slot_id: 's1',
          place_id: 'p1',
          place_name: 'Bar 1',
          starts_at: '20:00',
          user_id: 'u1',
          user_name: 'Carlos',
          people: 2,
          created_at: 1000,
        },
      ],
    }); // SELECT reservation
    client.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // DELETE reservation
    client.query.mockResolvedValueOnce({
      rows: [{ id: 's1', place_id: 'p1', starts_at: '20:00', capacity: 10, taken: 0, version: 2 }],
    }); // UPDATE slot
    client.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await store.cancel('11111111-1111-1111-1111-111111111111', () => true);
    expect(res.ok).toBe(true);
  });

  it('debe gestionar cuentas de Google y de negocio', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    poolInstance.query.mockResolvedValueOnce({
      rows: [{ google_sub: 'sub-1', email: 'test@example.com', name: 'Test', account_id: 'acc-1' }],
    });

    const acc = await store.findGoogleAccount('sub-1');
    expect(acc?.email).toBe('test@example.com');

    poolInstance.query.mockResolvedValueOnce({ rowCount: 1 });
    const ins = await store.insertGoogleAccount({
      googleSub: 'sub-2',
      email: 'two@example.com',
      name: 'Two',
      accountId: 'acc-2',
    });
    expect(ins).toBe('ok');

    poolInstance.query.mockResolvedValueOnce({
      rows: [
        {
          account_id: 'acc-1',
          legal_name: 'Negocio SA',
          nit: '9001234561',
          phone: '+573001234567',
          terms_version: 'v1',
          accepted_at: 1000,
        },
      ],
    });
    const bp = await store.businessProfileOf('acc-1');
    expect(bp?.legalName).toBe('Negocio SA');

    poolInstance.query.mockResolvedValueOnce({ rowCount: 1 });
    const insBp = await store.insertBusinessProfile({
      accountId: 'acc-1',
      legalName: 'Negocio SA',
      nit: '9001234561',
      phone: '+573001234567',
      termsVersion: 'v1',
      acceptedAt: 1000,
    });
    expect(insBp).toBe('ok');
  });

  it('debe listar reservas de usuario y lugar', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    poolInstance.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'r1',
          code: 'C1',
          slot_id: 's1',
          place_id: 'p1',
          place_name: 'P1',
          starts_at: '20:00',
          user_id: 'u1',
          user_name: 'U1',
          people: 1,
          created_at: 1000,
        },
      ],
    });
    const userRes = await store.reservationsOfUser('u1');
    expect(userRes).toHaveLength(1);

    poolInstance.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'r2',
          code: 'C2',
          slot_id: 's1',
          place_id: 'p1',
          place_name: 'P1',
          starts_at: '20:00',
          user_id: 'u2',
          user_name: 'U2',
          people: 2,
          created_at: 1000,
        },
      ],
    });
    const placeRes = await store.reservationsOfPlace('p1');
    expect(placeRes).toHaveLength(1);
  });

  it('debe cerrar conexión con close', async () => {
    const poolInstance = mockedPool.mock.results[0].value;
    await store.close();
    expect(poolInstance.end).toHaveBeenCalled();
  });
});
