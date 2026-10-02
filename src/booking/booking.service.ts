import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { BusService } from '../bus/bus.service';
import type { Identity } from '../common/identity';
import type {
  Category,
  Place,
  PlaceBase,
  PlaceDetail,
  PlaceEvent,
  Reservation,
  Slot,
  Zone,
} from './booking.types';
import { buildSeed } from './seed';

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function codigo(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return s;
}

/**
 * Lugares, franjas, eventos y reservas.
 *
 * CC-3 (lock optimista): toda escritura sobre una franja trae la `version` que
 * el cliente leyó. Si no coincide con la actual, se rechaza con 409
 * VERSION_CONFLICT en vez de pisar el cambio de otro.
 *
 * El estado vive en memoria. La comprobación de versión y la escritura ocurren
 * en el mismo paso síncrono, sin `await` entre ellas, así que en un proceso de
 * Node nadie puede colarse en medio: es el equivalente a
 * `UPDATE slots SET ... WHERE id = $1 AND version = $2`. Al pasar a PostgreSQL
 * se reemplaza este almacén por esa consulta y la regla queda igual.
 */
@Injectable()
export class BookingService {
  private places: PlaceBase[];
  private slots: Slot[];
  private events: PlaceEvent[];
  private reservations: Reservation[] = [];

  constructor(private readonly bus: BusService) {
    const seed = buildSeed();
    this.places = seed.places;
    this.slots = seed.slots;
    this.events = seed.events;
  }

  /* ------------------------------------------------------------------ */
  /* lecturas                                                            */
  /* ------------------------------------------------------------------ */

  listPlaces(q: { zone?: Zone; category?: Category } = {}): Place[] {
    return this.places
      .filter((p) => (!q.zone || p.zone === q.zone) && (!q.category || p.category === q.category))
      .map((p) => this.toPlace(p));
  }

  getPlace(id: string): PlaceDetail {
    const p = this.placeOrThrow(id);
    return {
      ...this.toPlace(p),
      slots: this.slots.filter((s) => s.placeId === id).map((s) => ({ ...s })),
      events: this.events.filter((e) => e.placeId === id).map((e) => ({ ...e })),
      promos: [],
    };
  }

  myReservations(userId: string): Reservation[] {
    return this.reservations
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  placeReservations(who: Identity, placeId: string): Reservation[] {
    this.assertOwnsPlace(who, placeId);
    return this.reservations
      .filter((r) => r.placeId === placeId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ------------------------------------------------------------------ */
  /* escrituras                                                          */
  /* ------------------------------------------------------------------ */

  /** CC-3: reserva `people` cupos en la franja si la versión leída sigue vigente. */
  async reserve(
    who: Identity & { userName: string },
    input: { slotId: string; people: number; version: number },
  ): Promise<Reservation> {
    const people = Number(input.people);
    if (!Number.isInteger(people) || people < 1 || people > 20) {
      throw new BadRequestException({ code: 'PERSONAS_INVALIDAS', message: 'Indica entre 1 y 20 personas.' });
    }
    const s = this.slotOrThrow(input.slotId);

    // --- sección crítica: comprobar y escribir sin ceder el hilo -------
    if (s.version !== Number(input.version)) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message:
          'Alguien reservó en esta franja mientras decidías. Actualizamos la disponibilidad: revisa y vuelve a intentar.',
      });
    }
    if (s.capacity - s.taken < people) {
      throw new ConflictException({ code: 'SIN_CUPO', message: 'No quedan cupos suficientes en esta franja.' });
    }
    s.taken += people;
    s.version += 1;
    // -------------------------------------------------------------------

    const p = this.placeOrThrow(s.placeId);
    const r: Reservation = {
      id: randomUUID(),
      slotId: s.id,
      placeId: p.id,
      placeName: p.name,
      startsAt: s.startsAt,
      people,
      code: `${codigo(3)}-${codigo(3)}`,
      userId: who.userId,
      userName: who.userName,
      createdAt: Date.now(),
    };
    this.reservations.push(r);

    await this.emitInventory(s);
    await this.bus.publish('RESERVE.OK', r, [`place:${p.id}`, `user:${who.userId}`]);
    return r;
  }

  /** Panel del negocio: misma regla de versión, porque el staff edita desde varios dispositivos. */
  async updateSlotCapacity(
    who: Identity,
    input: { placeId: string; slotId: string; capacity: number; version: number },
  ): Promise<Slot> {
    this.assertOwnsPlace(who, input.placeId);
    const capacity = Number(input.capacity);
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new BadRequestException({ code: 'CAPACIDAD_INVALIDA', message: 'La capacidad debe ser un entero positivo.' });
    }
    const s = this.slotOrThrow(input.slotId);
    if (s.placeId !== input.placeId) {
      throw new NotFoundException({ code: 'FRANJA_NO_EXISTE', message: 'La franja no pertenece a este lugar.' });
    }

    if (s.version !== Number(input.version)) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Otro dispositivo del equipo cambió esta franja antes que tú. Cargamos el valor actual.',
      });
    }
    if (capacity < s.taken) {
      throw new ConflictException({
        code: 'CAPACIDAD_MENOR',
        message: `Ya hay ${s.taken} cupos reservados: la capacidad no puede ser menor.`,
      });
    }
    s.capacity = capacity;
    s.version += 1;

    await this.emitInventory(s);
    return { ...s };
  }

  async createEvent(
    who: Identity,
    input: { placeId: string; title: string; startsAt: string; capacity: number },
  ): Promise<PlaceEvent> {
    const placeId = input.placeId ?? who.placeId;
    this.assertOwnsPlace(who, placeId);
    const title = String(input.title ?? '').trim();
    const capacity = Number(input.capacity);
    if (title.length < 3 || !input.startsAt || !Number.isInteger(capacity) || capacity < 1) {
      throw new BadRequestException({
        code: 'EVENTO_INVALIDO',
        message: 'El evento necesita título, hora y un cupo máximo mayor que cero.',
      });
    }
    const p = this.placeOrThrow(placeId);
    const e: PlaceEvent = { id: randomUUID(), placeId, title, startsAt: input.startsAt, capacity, taken: 0 };
    this.events.push(e);

    await this.bus.publish('PLACE.UPDATE', { placeId, freeSeats: this.freeSeats(placeId) }, [
      `zone:${p.zone}`,
      `place:${placeId}`,
    ]);
    return e;
  }

  /* ------------------------------------------------------------------ */
  /* utilidades                                                          */
  /* ------------------------------------------------------------------ */

  private freeSeats(placeId: string): number | null {
    const slots = this.slots.filter((s) => s.placeId === placeId);
    if (!slots.length) return null;
    return slots.reduce((acc, s) => acc + (s.capacity - s.taken), 0);
  }

  private toPlace(p: PlaceBase): Place {
    return { ...p, freeSeats: this.freeSeats(p.id) };
  }

  private placeOrThrow(id: string): PlaceBase {
    const p = this.places.find((x) => x.id === id);
    if (!p) throw new NotFoundException({ code: 'LUGAR_NO_EXISTE', message: 'El lugar no existe.' });
    return p;
  }

  private slotOrThrow(id: string): Slot {
    const s = this.slots.find((x) => x.id === id);
    if (!s) throw new NotFoundException({ code: 'FRANJA_NO_EXISTE', message: 'La franja no existe.' });
    return s;
  }

  /** Un negocio solo opera su propio lugar. */
  private assertOwnsPlace(who: Identity, placeId: string | undefined): void {
    if (who.role !== 'negocio' || !placeId || who.placeId !== placeId) {
      throw new ForbiddenException({
        code: 'LUGAR_AJENO',
        message: 'Solo el establecimiento dueño puede hacer esta operación.',
      });
    }
  }

  /** RT-1: el cambio de la franja a quien mira la ficha y el resumen a quien mira el mapa. */
  private async emitInventory(slot: Slot): Promise<void> {
    const p = this.places.find((x) => x.id === slot.placeId);
    if (!p) return;
    await this.bus.publish('INV.UPDATE', { placeId: p.id, slot: { ...slot } }, [`place:${p.id}`]);
    await this.bus.publish('PLACE.UPDATE', { placeId: p.id, freeSeats: this.freeSeats(p.id) }, [`zone:${p.zone}`]);
  }
}
