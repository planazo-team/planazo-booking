import type { Category, Place, PlaceEvent, Reservation, Slot, Zone } from '../booking.types';
import { buildSeed } from '../seed';
import type { Account, BookingStore, CancelFailure, InsertAccountResult, NewReservation, StoredPlace, WriteResult } from './booking.store';

/**
 * Almacén en memoria. La comprobación de versión y la escritura ocurren en el
 * mismo paso síncrono, sin `await` entre ellas, así que dentro de un proceso
 * de Node nadie puede colarse en medio: es el mismo contrato que el `UPDATE
 * ... WHERE version = $v` de PostgreSQL. Se pierde al reiniciar.
 */
export class MemoryBookingStore implements BookingStore {
  private places: StoredPlace[];
  private slots: Slot[];
  private events: PlaceEvent[];
  private reservations: Reservation[] = [];
  private accounts: Account[] = [];

  constructor() {
    const seed = buildSeed();
    this.places = seed.places;
    this.slots = seed.slots;
    this.events = seed.events;
  }

  async init(): Promise<void> {}

  async listPlaces(q: { zone?: Zone; category?: Category }): Promise<Place[]> {
    return this.places
      .filter((p) => (!q.zone || p.zone === q.zone) && (!q.category || p.category === q.category))
      .map((p) => ({ ...publico(p), freeSeats: this.free(p.id) }));
  }

  async getPlace(id: string) {
    const p = this.places.find((x) => x.id === id);
    return p ? { ...p } : null;
  }

  async placeOwnedBy(ownerId: string) {
    const p = this.places.find((x) => x.ownerId === ownerId);
    return p ? { ...p } : null;
  }

  async freeSeats(placeId: string) {
    return this.free(placeId);
  }

  async slotsOf(placeId: string) {
    return this.slots.filter((s) => s.placeId === placeId).map((s) => ({ ...s }));
  }

  async eventsOf(placeId: string) {
    return this.events.filter((e) => e.placeId === placeId).map((e) => ({ ...e }));
  }

  async getSlot(id: string) {
    const s = this.slots.find((x) => x.id === id);
    return s ? { ...s } : null;
  }

  async createPlace(place: StoredPlace, slots: Slot[]) {
    // Igual que el UNIQUE(owner_id) de PostgreSQL: dos altas simultáneas de la misma cuenta, entra una.
    if (place.ownerId && this.places.some((p) => p.ownerId === place.ownerId)) {
      throw Object.assign(new Error('owner_id duplicado'), { code: '23505' });
    }
    this.places.push({ ...place });
    this.slots.push(...slots.map((s) => ({ ...s })));
  }

  async createEvent(e: PlaceEvent) {
    this.events.push({ ...e });
  }

  async reserve(
    input: { slotId: string; version: number; people: number },
    r: NewReservation,
  ): Promise<WriteResult<{ slot: Slot; reservation: Reservation }>> {
    const s = this.slots.find((x) => x.id === input.slotId);
    if (!s) return { ok: false, code: 'FRANJA_NO_EXISTE' };
    // --- sección crítica: comprobar y escribir sin ceder el hilo -------
    if (s.version !== input.version) return { ok: false, code: 'VERSION_CONFLICT', current: { ...s } };
    if (s.capacity - s.taken < input.people) return { ok: false, code: 'SIN_CUPO', current: { ...s } };
    s.taken += input.people;
    s.version += 1;
    // -------------------------------------------------------------------
    const p = this.places.find((x) => x.id === s.placeId)!;
    const reservation: Reservation = {
      ...r,
      slotId: s.id,
      placeId: p.id,
      placeName: p.name,
      startsAt: s.startsAt,
      people: input.people,
    };
    this.reservations.push(reservation);
    return { ok: true, value: { slot: { ...s }, reservation } };
  }

  async updateCapacity(input: { slotId: string; version: number; capacity: number }): Promise<WriteResult<Slot>> {
    const s = this.slots.find((x) => x.id === input.slotId);
    if (!s) return { ok: false, code: 'FRANJA_NO_EXISTE' };
    if (s.version !== input.version) return { ok: false, code: 'VERSION_CONFLICT', current: { ...s } };
    if (input.capacity < s.taken) return { ok: false, code: 'CAPACIDAD_MENOR', current: { ...s } };
    s.capacity = input.capacity;
    s.version += 1;
    return { ok: true, value: { ...s } };
  }

  async cancel(
    reservationId: string,
    puede: (r: Reservation) => boolean,
  ): Promise<{ ok: true; value: { reservation: Reservation; slot: Slot } } | { ok: false; code: CancelFailure }> {
    // Comprobar, borrar y devolver cupos sin ceder el hilo: igual de indivisible que la transacción.
    const i = this.reservations.findIndex((r) => r.id === reservationId);
    if (i === -1) return { ok: false, code: 'RESERVA_NO_EXISTE' };
    const r = this.reservations[i];
    if (!puede(r)) return { ok: false, code: 'RESERVA_AJENA' };
    this.reservations.splice(i, 1);
    const s = this.slots.find((x) => x.id === r.slotId)!;
    s.taken = Math.max(0, s.taken - r.people);
    s.version += 1;
    return { ok: true, value: { reservation: r, slot: { ...s } } };
  }

  async findAccount(nameKey: string) {
    const a = this.accounts.find((x) => x.nameKey === nameKey);
    return a ? { ...a } : null;
  }

  async insertAccount(a: Account): Promise<InsertAccountResult> {
    // Igual que la PRIMARY KEY (name_key) y el UNIQUE (account_id) de PostgreSQL.
    if (this.accounts.some((x) => x.nameKey === a.nameKey)) return 'NOMBRE_TOMADO';
    if (this.accounts.some((x) => x.accountId === a.accountId)) return 'ID_TOMADO';
    this.accounts.push({ ...a });
    return 'ok';
  }

  async reservationsOfUser(userId: string) {
    return this.reservations.filter((r) => r.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
  }

  async reservationsOfPlace(placeId: string) {
    return this.reservations.filter((r) => r.placeId === placeId).sort((a, b) => b.createdAt - a.createdAt);
  }

  private free(placeId: string): number | null {
    const slots = this.slots.filter((s) => s.placeId === placeId);
    if (!slots.length) return null;
    return slots.reduce((acc, s) => acc + (s.capacity - s.taken), 0);
  }
}

/** Quita el dueño antes de mostrar un lugar. */
export function publico(p: StoredPlace) {
  const { ownerId: _owner, ownerName: _ownerName, ...rest } = p;
  return rest;
}
