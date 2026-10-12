import { Logger } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import type { Category, Place, PlaceEvent, Reservation, Slot, Zone } from '../booking.types';
import { buildSeed } from '../seed';
import type { BookingStore, CancelFailure, NewReservation, StoredPlace, WriteResult } from './booking.store';

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

const PLACE_COLS = 'p.id, p.name, p.category, p.zone, p.lat, p.lng, p.description, p.price_level, p.cover, p.owner_id';

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
          `INSERT INTO booking.places (id, name, category, zone, lat, lng, description, price_level)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [p.id, p.name, p.category, p.zone, p.lat, p.lng, p.description, p.priceLevel],
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
      const { ownerId: _owner, ...p } = toPlace(r);
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
        `INSERT INTO booking.places (id, name, category, zone, lat, lng, description, price_level, cover, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [p.id, p.name, p.category, p.zone, p.lat, p.lng, p.description, p.priceLevel, p.cover ?? null, p.ownerId ?? null],
      );
      for (const s of slots) {
        await c.query(
          'INSERT INTO booking.slots (id, place_id, starts_at, capacity, taken, version) VALUES ($1,$2,$3,$4,$5,$6)',
          [s.id, s.placeId, s.startsAt, s.capacity, s.taken, s.version],
        );
      }
    });
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
