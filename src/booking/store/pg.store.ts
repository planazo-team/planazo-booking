import { Logger } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import type { Category, Place, PlaceEvent, Reservation, Slot, Zone } from '../booking.types';
import { buildSeed } from '../seed';
import { claveNombre } from '../cuentas';
import type { Account, BookingStore, CancelFailure, InsertAccountResult, NewReservation, StoredPlace, WriteResult } from './booking.store';

/**
 * Almacén en PostgreSQL, esquema `booking` (puede compartir base con otros
 * servicios sin chocar).
 *
 * CC-3 queda en manos de la base: una reserva es
 *
 *   UPDATE booking.slots SET taken = taken + $p, version = version + 1
 *    WHERE id = $1 AND version = $2 AND capacity - taken >= $p
 *
 * Si dos peticiones llegan con la misma versión, la segunda espera el lock de
 * fila de la primera, re-evalúa el WHERE contra la fila ya actualizada y no
 * encuentra nada: 0 filas, conflicto. Y por si algo se escapara, la tabla
 * tiene `CHECK (taken <= capacity)`: la sobreventa es imposible a nivel de
 * esquema. Funciona igual con varias réplicas del servicio.
 */

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS booking;

CREATE TABLE IF NOT EXISTS booking.places (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL,
  zone        text NOT NULL,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  description text NOT NULL DEFAULT '',
  price_level smallint NOT NULL DEFAULT 2,
  cover       text,
  owner_id    text UNIQUE,
  created_at  bigint NOT NULL DEFAULT (extract(epoch FROM now()) * 1000)::bigint
);

CREATE TABLE IF NOT EXISTS booking.slots (
  id        text PRIMARY KEY,
  place_id  text NOT NULL REFERENCES booking.places(id),
  starts_at text NOT NULL,
  capacity  integer NOT NULL CHECK (capacity >= 0),
  taken     integer NOT NULL DEFAULT 0,
  version   integer NOT NULL DEFAULT 1,
  CONSTRAINT slots_sin_sobreventa CHECK (taken >= 0 AND taken <= capacity)
);
CREATE INDEX IF NOT EXISTS slots_place_idx ON booking.slots(place_id);

CREATE TABLE IF NOT EXISTS booking.events (
  id        text PRIMARY KEY,
  place_id  text NOT NULL REFERENCES booking.places(id),
  title     text NOT NULL,
  starts_at text NOT NULL,
  capacity  integer NOT NULL,
  taken     integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_place_idx ON booking.events(place_id);

CREATE TABLE IF NOT EXISTS booking.reservations (
  id         uuid PRIMARY KEY,
  slot_id    text NOT NULL REFERENCES booking.slots(id),
  place_id   text NOT NULL REFERENCES booking.places(id),
  place_name text NOT NULL,
  starts_at  text NOT NULL,
  people     integer NOT NULL CHECK (people > 0),
  code       text NOT NULL,
  user_id    text NOT NULL,
  user_name  text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_user_idx ON booking.reservations(user_id);
CREATE INDEX IF NOT EXISTS reservations_place_idx ON booking.reservations(place_id);

-- Nombres únicos: cada nombre (sin mayúsculas ni tildes) es una cuenta, atada
-- al navegador que lo reclamó primero.
CREATE TABLE IF NOT EXISTS booking.accounts (
  name_key   text PRIMARY KEY,
  name       text NOT NULL,
  account_id text NOT NULL UNIQUE,
  device_id  text NOT NULL,
  created_at bigint NOT NULL DEFAULT (extract(epoch FROM now()) * 1000)::bigint
);

ALTER TABLE booking.places ADD COLUMN IF NOT EXISTS owner_name text;

-- Los tres negocios creados antes de que existieran las cuentas: el nombre con
-- que entró su dueño sale de su PLACE.CREATED en el event log de realtime.
UPDATE booking.places SET owner_name = v.n
  FROM (VALUES ('l-th8fpg', 'Peter Parker'), ('l-lkpug3', 'pedro'), ('l-9jqydx', 'Maria Leon')) AS v(id, n)
 WHERE booking.places.id = v.id AND booking.places.owner_name IS NULL;
`;

type Row = Record<string, unknown>;

const toPlace = (r: Row): StoredPlace => ({
  id: String(r.id),
  name: String(r.name),
  category: r.category as Category,
  zone: r.zone as Zone,
  lat: Number(r.lat),
  lng: Number(r.lng),
  description: String(r.description ?? ''),
  priceLevel: Number(r.price_level) as StoredPlace['priceLevel'],
  cover: (r.cover as string | null) ?? null,
  ownerId: (r.owner_id as string | null) ?? null,
  ownerName: (r.owner_name as string | null) ?? null,
});

const toSlot = (r: Row): Slot => ({
  id: String(r.id),
  placeId: String(r.place_id),
  startsAt: String(r.starts_at),
  capacity: Number(r.capacity),
  taken: Number(r.taken),
  version: Number(r.version),
});

const toEvent = (r: Row): PlaceEvent => ({
  id: String(r.id),
  placeId: String(r.place_id),
  title: String(r.title),
  startsAt: String(r.starts_at),
  capacity: Number(r.capacity),
  taken: Number(r.taken),
});

const toReservation = (r: Row): Reservation => ({
  id: String(r.id),
  slotId: String(r.slot_id),
  placeId: String(r.place_id),
  placeName: String(r.place_name),
  startsAt: String(r.starts_at),
  people: Number(r.people),
  code: String(r.code),
  userId: String(r.user_id),
  userName: String(r.user_name),
  createdAt: Number(r.created_at),
});

const PLACE_COLS = 'p.id, p.name, p.category, p.zone, p.lat, p.lng, p.description, p.price_level, p.cover, p.owner_id, p.owner_name';

export class PgBookingStore implements BookingStore {
  private readonly logger = new Logger(PgBookingStore.name);
  private readonly pool: Pool;

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
    this.pool.on('error', (err) => this.logger.error(`PostgreSQL: ${err.message}`));
  }

  async init(): Promise<void> {
    const c = await this.pool.connect();
    try {
      // Si arrancan dos réplicas a la vez, solo una crea el esquema y siembra.
      await c.query(`SELECT pg_advisory_lock(hashtext('planazo-booking-init'))`);
      await c.query(SCHEMA);
      const seed = buildSeed();
      await c.query('BEGIN');
      for (const p of seed.places) {
        await c.query(
          `INSERT INTO booking.places (id, name, category, zone, lat, lng, description, price_level, cover)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [p.id, p.name, p.category, p.zone, p.lat, p.lng, p.description, p.priceLevel, p.cover ?? null],
        );
      }
      for (const s of seed.slots) {
        await c.query(
          `INSERT INTO booking.slots (id, place_id, starts_at, capacity, taken, version)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
          [s.id, s.placeId, s.startsAt, s.capacity, s.taken, s.version],
        );
      }
      for (const e of seed.events) {
        await c.query(
          `INSERT INTO booking.events (id, place_id, title, starts_at, capacity, taken)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
          [e.id, e.placeId, e.title, e.startsAt, e.capacity, e.taken],
        );
      }
      // Cada dueño de negocio que ya existía queda con su nombre reservado y
      // su mismo id: sigue entrando a su lugar desde su navegador.
      const { rows: duenos } = await c.query(
        `SELECT owner_id, owner_name FROM booking.places WHERE owner_id LIKE 'n-%' AND owner_name IS NOT NULL`,
      );
      for (const d of duenos) {
        const id = String(d.owner_id).slice(2);
        await c.query(
          `INSERT INTO booking.accounts (name_key, name, account_id, device_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [claveNombre(String(d.owner_name)), String(d.owner_name), id, id],
        );
      }
      await this.repararHerencias(c);
      await c.query('COMMIT');
      this.logger.log('Esquema booking listo y catálogo semilla cargado (PostgreSQL).');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await c.query(`SELECT pg_advisory_unlock(hashtext('planazo-booking-init'))`).catch(() => undefined);
      c.release();
    }
  }

  /**
   * Repara las cuentas que heredaron el id de su navegador junto con datos de
   * otra persona (reservas o negocio hechos antes con otro nombre). La cuenta
   * recibe un id nuevo y se lleva solo lo que hizo con su nombre después de
   * reclamarlo; lo anterior se queda con el id viejo, de quien lo hizo.
   */
  private async repararHerencias(c: PoolClient): Promise<void> {
    const { rows: cuentas } = await c.query(
      `SELECT name_key, name, account_id, created_at FROM booking.accounts WHERE account_id = device_id`,
    );
    for (const a of cuentas) {
      const id = String(a.account_id);
      const desde = Number(a.created_at);
      const { rows: previas } = await c.query(
        `SELECT user_name FROM booking.reservations WHERE user_id = $1 AND created_at < $2`,
        [`c-${id}`, desde],
      );
      const { rows: lugar } = await c.query(`SELECT owner_name FROM booking.places WHERE owner_id = $1`, [`n-${id}`]);
      const ajenas = previas.some((r) => claveNombre(String(r.user_name)) !== a.name_key);
      const negocioAjeno = !!lugar[0]?.owner_name && claveNombre(String(lugar[0].owner_name)) !== a.name_key;
      if (!ajenas && !negocioAjeno) continue;

      const nuevo = `${id}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await c.query('UPDATE booking.accounts SET account_id = $1 WHERE name_key = $2', [nuevo, a.name_key]);
      await c.query(
        `UPDATE booking.reservations SET user_id = $1 WHERE user_id = $2 AND created_at >= $3`,
        [`c-${nuevo}`, `c-${id}`, desde],
      );
      this.logger.warn(`Cuenta «${a.name}» separada de datos de otra persona del mismo navegador.`);
    }
  }

  async listPlaces(q: { zone?: Zone; category?: Category }): Promise<Place[]> {
    const { rows } = await this.pool.query(
      `SELECT ${PLACE_COLS}, f.free
         FROM booking.places p
         LEFT JOIN (SELECT place_id, SUM(capacity - taken)::int AS free FROM booking.slots GROUP BY place_id) f
           ON f.place_id = p.id
        WHERE ($1::text IS NULL OR p.zone = $1) AND ($2::text IS NULL OR p.category = $2)
        ORDER BY p.created_at, p.id`,
      [q.zone ?? null, q.category ?? null],
    );
    return rows.map((r) => {
      const { ownerId: _owner, ownerName: _ownerName, ...p } = toPlace(r);
      return { ...p, freeSeats: r.free === null ? null : Number(r.free) };
    });
  }

  async getPlace(id: string) {
    const { rows } = await this.pool.query(`SELECT ${PLACE_COLS} FROM booking.places p WHERE p.id = $1`, [id]);
    return rows[0] ? toPlace(rows[0]) : null;
  }

  async placeOwnedBy(ownerId: string) {
    const { rows } = await this.pool.query(`SELECT ${PLACE_COLS} FROM booking.places p WHERE p.owner_id = $1`, [ownerId]);
    return rows[0] ? toPlace(rows[0]) : null;
  }

  async freeSeats(placeId: string): Promise<number | null> {
    const { rows } = await this.pool.query(
      'SELECT COUNT(*)::int AS n, COALESCE(SUM(capacity - taken), 0)::int AS free FROM booking.slots WHERE place_id = $1',
      [placeId],
    );
    return rows[0].n === 0 ? null : Number(rows[0].free);
  }

  async slotsOf(placeId: string) {
    const { rows } = await this.pool.query('SELECT * FROM booking.slots WHERE place_id = $1 ORDER BY starts_at, id', [placeId]);
    return rows.map(toSlot);
  }

  async eventsOf(placeId: string) {
    const { rows } = await this.pool.query('SELECT * FROM booking.events WHERE place_id = $1 ORDER BY starts_at, id', [placeId]);
    return rows.map(toEvent);
  }

  async getSlot(id: string) {
    const { rows } = await this.pool.query('SELECT * FROM booking.slots WHERE id = $1', [id]);
    return rows[0] ? toSlot(rows[0]) : null;
  }

  async createPlace(p: StoredPlace, slots: Slot[]) {
    await this.tx(async (c) => {
      await c.query(
        `INSERT INTO booking.places (id, name, category, zone, lat, lng, description, price_level, cover, owner_id, owner_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [p.id, p.name, p.category, p.zone, p.lat, p.lng, p.description, p.priceLevel, p.cover ?? null, p.ownerId ?? null, p.ownerName ?? null],
      );
      for (const s of slots) {
        await c.query(
          'INSERT INTO booking.slots (id, place_id, starts_at, capacity, taken, version) VALUES ($1,$2,$3,$4,$5,$6)',
          [s.id, s.placeId, s.startsAt, s.capacity, s.taken, s.version],
        );
      }
    });
  }

  async findAccount(nameKey: string): Promise<Account | null> {
    const { rows } = await this.pool.query('SELECT * FROM booking.accounts WHERE name_key = $1', [nameKey]);
    const r = rows[0];
    return r ? { nameKey: String(r.name_key), name: String(r.name), accountId: String(r.account_id), deviceId: String(r.device_id) } : null;
  }

  async insertAccount(a: Account): Promise<InsertAccountResult> {
    // Un solo INSERT: la PRIMARY KEY y el UNIQUE deciden si dos navegadores piden
    // el mismo nombre a la vez. Entra uno; el otro ve 0 filas.
    const { rowCount } = await this.pool.query(
      `INSERT INTO booking.accounts (name_key, name, account_id, device_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [a.nameKey, a.name, a.accountId, a.deviceId],
    );
    if (rowCount === 1) return 'ok';
    return (await this.findAccount(a.nameKey)) ? 'NOMBRE_TOMADO' : 'ID_TOMADO';
  }

  async createEvent(e: PlaceEvent) {
    await this.pool.query(
      'INSERT INTO booking.events (id, place_id, title, starts_at, capacity, taken) VALUES ($1,$2,$3,$4,$5,$6)',
      [e.id, e.placeId, e.title, e.startsAt, e.capacity, e.taken],
    );
  }

  async reserve(
    input: { slotId: string; version: number; people: number },
    r: NewReservation,
  ): Promise<WriteResult<{ slot: Slot; reservation: Reservation }>> {
    return this.tx(async (c) => {
      const upd = await c.query(
        `UPDATE booking.slots SET taken = taken + $3, version = version + 1
          WHERE id = $1 AND version = $2 AND capacity - taken >= $3
          RETURNING *`,
        [input.slotId, input.version, input.people],
      );
      if (upd.rowCount === 0) {
        const cur = await c.query('SELECT * FROM booking.slots WHERE id = $1', [input.slotId]);
        if (!cur.rows[0]) return { ok: false as const, code: 'FRANJA_NO_EXISTE' as const };
        const current = toSlot(cur.rows[0]);
        return {
          ok: false as const,
          code: current.version !== input.version ? ('VERSION_CONFLICT' as const) : ('SIN_CUPO' as const),
          current,
        };
      }
      const slot = toSlot(upd.rows[0]);
      const ins = await c.query(
        `INSERT INTO booking.reservations (id, slot_id, place_id, place_name, starts_at, people, code, user_id, user_name, created_at)
         SELECT $1, s.id, p.id, p.name, s.starts_at, $3, $4, $5, $6, $7
           FROM booking.slots s JOIN booking.places p ON p.id = s.place_id
          WHERE s.id = $2
         RETURNING *`,
        [r.id, slot.id, input.people, r.code, r.userId, r.userName, r.createdAt],
      );
      return { ok: true as const, value: { slot, reservation: toReservation(ins.rows[0]) } };
    });
  }

  async updateCapacity(input: { slotId: string; version: number; capacity: number }): Promise<WriteResult<Slot>> {
    const upd = await this.pool.query(
      `UPDATE booking.slots SET capacity = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND taken <= $3
        RETURNING *`,
      [input.slotId, input.version, input.capacity],
    );
    if (upd.rowCount && upd.rows[0]) return { ok: true, value: toSlot(upd.rows[0]) };
    const cur = await this.getSlot(input.slotId);
    if (!cur) return { ok: false, code: 'FRANJA_NO_EXISTE' };
    return { ok: false, code: cur.version !== input.version ? 'VERSION_CONFLICT' : 'CAPACIDAD_MENOR', current: cur };
  }

  async cancel(
    reservationId: string,
    puede: (r: Reservation) => boolean,
  ): Promise<{ ok: true; value: { reservation: Reservation; slot: Slot } } | { ok: false; code: CancelFailure }> {
    if (!/^[0-9a-f-]{36}$/i.test(reservationId)) return { ok: false, code: 'RESERVA_NO_EXISTE' };
    return this.tx(async (c) => {
      // FOR UPDATE: una segunda cancelación simultánea espera y ya no encuentra la fila.
      const sel = await c.query('SELECT * FROM booking.reservations WHERE id = $1 FOR UPDATE', [reservationId]);
      if (!sel.rows[0]) return { ok: false as const, code: 'RESERVA_NO_EXISTE' as const };
      const reservation = toReservation(sel.rows[0]);
      if (!puede(reservation)) return { ok: false as const, code: 'RESERVA_AJENA' as const };
      await c.query('DELETE FROM booking.reservations WHERE id = $1', [reservationId]);
      const upd = await c.query(
        `UPDATE booking.slots SET taken = GREATEST(0, taken - $2), version = version + 1
          WHERE id = $1 RETURNING *`,
        [reservation.slotId, reservation.people],
      );
      return { ok: true as const, value: { reservation, slot: toSlot(upd.rows[0]) } };
    });
  }

  async reservationsOfUser(userId: string) {
    const { rows } = await this.pool.query(
      'SELECT * FROM booking.reservations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200',
      [userId],
    );
    return rows.map(toReservation);
  }

  async reservationsOfPlace(placeId: string) {
    const { rows } = await this.pool.query(
      'SELECT * FROM booking.reservations WHERE place_id = $1 ORDER BY created_at DESC LIMIT 500',
      [placeId],
    );
    return rows.map(toReservation);
  }

  async close() {
    await this.pool.end();
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
