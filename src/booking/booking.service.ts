import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { BusService } from '../bus/bus.service';
import type { Identity } from '../common/identity';
import type { Category, Place, PlaceDetail, PlaceEvent, Reservation, Slot, Zone } from './booking.types';
import { armarLugar, type NewPlaceInput } from './new-place';
import { BOOKING_STORE, type BookingStore, type StoredPlace, type WriteFailure } from './store/booking.store';
import { publico } from './store/memory.store';

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function codigo(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return s;
}

/** Mensajes de cada conflicto: nunca un error genérico. */
const MENSAJE: Record<WriteFailure, { reserva: string; panel: string }> = {
  VERSION_CONFLICT: {
    reserva: 'Alguien reservó en esta franja mientras decidías. Actualizamos la disponibilidad: revisa y vuelve a intentar.',
    panel: 'Otro dispositivo del equipo cambió esta franja antes que tú. Cargamos el valor actual.',
  },
  SIN_CUPO: {
    reserva: 'No quedan cupos suficientes en esta franja.',
    panel: 'No quedan cupos suficientes en esta franja.',
  },
  CAPACIDAD_MENOR: {
    reserva: 'La capacidad no puede ser menor que lo ya reservado.',
    panel: 'Ya hay cupos reservados: la capacidad no puede ser menor.',
  },
  FRANJA_NO_EXISTE: { reserva: 'La franja no existe.', panel: 'La franja no existe.' },
};

/**
 * Lugares, franjas, eventos y reservas.
 *
 * CC-3 (lock optimista): toda escritura sobre una franja trae la `version` que
 * el cliente leyó. Si no coincide con la actual, se rechaza con 409
 * VERSION_CONFLICT en vez de pisar el cambio de otro. La comparación y la
 * escritura las hace el almacén en un solo paso (en PostgreSQL, un UPDATE con
 * la versión en el WHERE): ver store/booking.store.ts.
 */
@Injectable()
export class BookingService implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly bus: BusService,
    @Inject(BOOKING_STORE) private readonly store: BookingStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.init();
  }

  async onModuleDestroy(): Promise<void> {
    await this.store.close?.();
  }

  /* ------------------------------------------------------------------ */
  /* lecturas                                                            */
  /* ------------------------------------------------------------------ */

  listPlaces(q: { zone?: Zone; category?: Category } = {}): Promise<Place[]> {
    return this.store.listPlaces(q);
  }

  async getPlace(id: string): Promise<PlaceDetail> {
    const p = await this.placeOrThrow(id);
    const [slots, events, freeSeats] = await Promise.all([
      this.store.slotsOf(id),
      this.store.eventsOf(id),
      this.store.freeSeats(id),
    ]);
    return { ...publico(p), freeSeats, slots, events, promos: [] };
  }

  /** GET /places/owned: el lugar del negocio que pregunta, o 404 si aún no tiene. */
  async ownedPlace(who: Identity): Promise<Place> {
    const p = await this.store.placeOwnedBy(who.userId);
    if (!p) throw new NotFoundException({ code: 'SIN_LUGAR', message: 'Todavía no has creado tu lugar.' });
    return { ...publico(p), freeSeats: await this.store.freeSeats(p.id) };
  }

  myReservations(userId: string): Promise<Reservation[]> {
    return this.store.reservationsOfUser(userId);
  }

  async placeReservations(who: Identity, placeId: string): Promise<Reservation[]> {
    this.assertOwnsPlace(who, placeId);
    return this.store.reservationsOfPlace(placeId);
  }

  /* ------------------------------------------------------------------ */
  /* escrituras                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * POST /places: un negocio crea su lugar. Uno por cuenta. Se anuncia con
   * PLACE.CREATED en su zona, así aparece en el mapa de todos sin recargar,
   * y promo lo agrega a su catálogo para poder lanzar promociones.
   */
  async createPlace(who: Identity & { userName: string }, input: NewPlaceInput): Promise<Place> {
    if (who.role !== 'negocio') {
      throw new ForbiddenException({ code: 'ROL_NO_AUTORIZADO', message: 'Solo una cuenta de negocio puede crear un lugar.' });
    }
    const existente = await this.store.placeOwnedBy(who.userId);
    if (existente) {
      throw new ConflictException({
        code: 'YA_TIENE_LUGAR',
        message: `Tu cuenta ya administra ${existente.name}.`,
        placeId: existente.id,
      });
    }

    const id = `l-${codigo(6).toLowerCase()}`;
    const { place, slots } = armarLugar(id, input);
    const stored: StoredPlace = { ...place, ownerId: who.userId };
    try {
      await this.store.createPlace(stored, slots);
    } catch (err) {
      // owner_id es UNIQUE: dos altas simultáneas de la misma cuenta, solo una entra.
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException({ code: 'YA_TIENE_LUGAR', message: 'Tu cuenta ya administra un lugar.' });
      }
      throw err;
    }

    const freeSeats = slots.length ? slots.reduce((a, s) => a + s.capacity, 0) : null;
    const created: Place = { ...place, freeSeats };
    await this.bus.publish('PLACE.CREATED', { place: created, ownerName: who.userName }, [
      `zone:${place.zone}`,
      `place:${place.id}`,
    ]);
    return created;
  }

  /** CC-3: reserva `people` cupos en la franja si la versión leída sigue vigente. */
  async reserve(
    who: Identity & { userName: string },
    input: { slotId: string; people: number; version: number },
  ): Promise<Reservation> {
    const people = Number(input.people);
    if (!Number.isInteger(people) || people < 1 || people > 20) {
      throw new BadRequestException({ code: 'PERSONAS_INVALIDAS', message: 'Indica entre 1 y 20 personas.' });
    }
    const version = Number(input.version);
    if (!input.slotId || !Number.isInteger(version)) {
      throw new BadRequestException({ code: 'RESERVA_INVALIDA', message: 'Falta la franja o su versión.' });
    }

    const r = await this.store.reserve(
      { slotId: String(input.slotId), version, people },
      {
        id: randomUUID(),
        code: `${codigo(3)}-${codigo(3)}`,
        userId: who.userId,
        userName: who.userName,
        createdAt: Date.now(),
      },
    );
    if (!r.ok) this.fallo(r.code, 'reserva');

    const { slot, reservation } = r.value;
    await this.emitInventory(slot);
    await this.bus.publish('RESERVE.OK', reservation, [`place:${slot.placeId}`, `user:${who.userId}`]);
    return reservation;
  }

  /**
   * DELETE /reservations/:id: cancela quien reservó o el negocio dueño del
   * lugar. Los cupos vuelven a la franja (con su versión nueva) y se avisa en
   * vivo al mapa, a la ficha, al panel del negocio y a la persona.
   */
  async cancel(who: Identity, reservationId: string): Promise<Reservation> {
    const r = await this.store.cancel(
      String(reservationId ?? ''),
      (res) => res.userId === who.userId || (who.role === 'negocio' && who.placeId === res.placeId),
    );
    if (!r.ok) {
      if (r.code === 'RESERVA_AJENA') {
        throw new ForbiddenException({ code: 'RESERVA_AJENA', message: 'Solo quien reservó o el lugar pueden cancelar esta reserva.' });
      }
      throw new NotFoundException({ code: 'RESERVA_NO_EXISTE', message: 'La reserva no existe o ya fue cancelada.' });
    }
    const { reservation, slot } = r.value;
    await this.emitInventory(slot);
    await this.bus.publish(
      'RESERVE.CANCELLED',
      { id: reservation.id, placeId: reservation.placeId, slotId: reservation.slotId, people: reservation.people, userId: reservation.userId },
      [`place:${reservation.placeId}`, `user:${reservation.userId}`],
    );
    return reservation;
  }

  /** Panel del negocio: misma regla de versión, porque el staff edita desde varios dispositivos. */
  async updateSlotCapacity(
    who: Identity,
    input: { placeId: string; slotId: string; capacity: number; version: number },
  ): Promise<Slot> {
    this.assertOwnsPlace(who, input.placeId);
    const capacity = Number(input.capacity);
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 1000) {
      throw new BadRequestException({ code: 'CAPACIDAD_INVALIDA', message: 'La capacidad debe ser un entero entre 0 y 1000.' });
    }
    const actual = await this.store.getSlot(input.slotId);
    if (!actual || actual.placeId !== input.placeId) {
      throw new NotFoundException({ code: 'FRANJA_NO_EXISTE', message: 'La franja no pertenece a este lugar.' });
    }

    const r = await this.store.updateCapacity({ slotId: input.slotId, version: Number(input.version), capacity });
    if (!r.ok) this.fallo(r.code, 'panel', r.current);

    await this.emitInventory(r.value);
    return r.value;
  }

  async createEvent(
    who: Identity,
    input: { placeId: string; title: string; startsAt: string; capacity: number },
  ): Promise<PlaceEvent> {
    const placeId = input.placeId ?? who.placeId;
    this.assertOwnsPlace(who, placeId);
    const title = String(input.title ?? '').trim();
    const capacity = Number(input.capacity);
    if (title.length < 3 || title.length > 60 || !/^\d{2}:\d{2}$/.test(String(input.startsAt ?? '')) || !Number.isInteger(capacity) || capacity < 1) {
      throw new BadRequestException({
        code: 'EVENTO_INVALIDO',
        message: 'El evento necesita título, hora (HH:MM) y un cupo máximo mayor que cero.',
      });
    }
    const p = await this.placeOrThrow(placeId);
    const e: PlaceEvent = { id: randomUUID(), placeId, title, startsAt: input.startsAt, capacity, taken: 0 };
    await this.store.createEvent(e);

    await this.bus.publish('PLACE.UPDATE', { placeId, freeSeats: await this.store.freeSeats(placeId) }, [
      `zone:${p.zone}`,
      `place:${placeId}`,
    ]);
    return e;
  }

  /* ------------------------------------------------------------------ */
  /* utilidades                                                          */
  /* ------------------------------------------------------------------ */

  private fallo(code: WriteFailure, donde: 'reserva' | 'panel', current?: Slot): never {
    const message = MENSAJE[code][donde];
    if (code === 'FRANJA_NO_EXISTE') throw new NotFoundException({ code, message });
    throw new ConflictException({ code, message, ...(current ? { current } : {}) });
  }

  private async placeOrThrow(id: string): Promise<StoredPlace> {
    const p = await this.store.getPlace(id);
    if (!p) throw new NotFoundException({ code: 'LUGAR_NO_EXISTE', message: 'El lugar no existe.' });
    return p;
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
    const p = await this.store.getPlace(slot.placeId);
    if (!p) return;
    await this.bus.publish('INV.UPDATE', { placeId: p.id, slot }, [`place:${p.id}`]);
    await this.bus.publish('PLACE.UPDATE', { placeId: p.id, freeSeats: await this.store.freeSeats(p.id) }, [
      `zone:${p.zone}`,
    ]);
  }
}
