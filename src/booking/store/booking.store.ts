import type { Category, Place, PlaceBase, PlaceEvent, Reservation, Slot, Zone } from '../booking.types';

/**
 * Dónde viven lugares, franjas, eventos y reservas. Hay dos implementaciones
 * con la misma forma:
 *
 *   - `PgBookingStore`: PostgreSQL (esquema `booking`). Es la de producción:
 *     sobrevive a los redespliegues y el lock optimista lo hace cumplir la
 *     propia base con `UPDATE ... WHERE version = $v`.
 *   - `MemoryBookingStore`: en memoria, para tests y para correr sin base.
 *
 * Las dos operaciones que importan para CC-3 (`reserve` y `updateCapacity`)
 * comparan la versión y escriben en un solo paso indivisible: si alguien
 * escribió antes, devuelven el motivo en vez de pisar el cambio.
 */

export const BOOKING_STORE = 'planazo:bookingStore';

export type WriteFailure = 'FRANJA_NO_EXISTE' | 'VERSION_CONFLICT' | 'SIN_CUPO' | 'CAPACIDAD_MENOR';

export type CancelFailure = 'RESERVA_NO_EXISTE' | 'RESERVA_AJENA';

export type WriteResult<T> = { ok: true; value: T } | { ok: false; code: WriteFailure; current?: Slot };

/** Lugar con dueño. `ownerId` y `ownerName` nunca salen hacia el cliente. */
export type StoredPlace = PlaceBase & { ownerId?: string | null; ownerName?: string | null };

/**
 * Una cuenta: un nombre único (sin distinguir mayúsculas ni tildes) atado al
 * navegador que lo reclamó primero. `accountId` es lo que el gateway pone en
 * el token (`c-<accountId>` o `n-<accountId>`).
 */
export interface Account {
  nameKey: string;
  name: string;
  accountId: string;
  deviceId: string;
}

/** Resultado de reclamar una cuenta: entra, o choca por el nombre o por el id. */
export type InsertAccountResult = 'ok' | 'NOMBRE_TOMADO' | 'ID_TOMADO';

/**
 * Una cuenta de Google. `googleSub` es el id estable que Google da a cada
 * persona (no cambia aunque cambie el correo). `accountId` es lo que el
 * gateway pone en el token: `c-<accountId>` en modo cliente y `n-<accountId>`
 * en modo negocio. Toda cuenta puede ser cliente; el modo negocio se activa
 * registrando el negocio (`BusinessProfile`).
 */
export interface GoogleAccount {
  googleSub: string;
  email: string;
  name: string;
  accountId: string;
}

/**
 * Lo que se pide para activar el modo negocio. El NIT es único: un negocio
 * (persona jurídica o natural) solo puede quedar registrado en una cuenta.
 */
export interface BusinessProfile {
  accountId: string;
  legalName: string;
  /** Sin puntos ni guion: la base seguida del dígito de verificación. */
  nit: string;
  phone: string;
  termsVersion: string;
  acceptedAt: number;
}

export type InsertBusinessResult = 'ok' | 'YA_ES_NEGOCIO' | 'NIT_EN_USO';

export type InsertGoogleResult = 'ok' | 'YA_EXISTE' | 'ID_TOMADO';

export interface NewReservation {
  id: string;
  code: string;
  userId: string;
  userName: string;
  createdAt: number;
}

export interface BookingStore {
  /** Crea el esquema si hace falta y carga el catálogo semilla la primera vez. */
  init(): Promise<void>;

  listPlaces(q: { zone?: Zone; category?: Category }): Promise<Place[]>;
  getPlace(id: string): Promise<StoredPlace | null>;
  /** El lugar que administra un usuario (un negocio tiene uno). */
  placeOwnedBy(ownerId: string): Promise<StoredPlace | null>;
  freeSeats(placeId: string): Promise<number | null>;
  slotsOf(placeId: string): Promise<Slot[]>;
  eventsOf(placeId: string): Promise<PlaceEvent[]>;
  getSlot(id: string): Promise<Slot | null>;

  createPlace(place: StoredPlace, slots: Slot[]): Promise<void>;
  createEvent(e: PlaceEvent): Promise<void>;

  /** CC-3: suma `people` a la franja solo si la versión sigue siendo `version` y alcanza el cupo. */
  reserve(input: { slotId: string; version: number; people: number }, r: NewReservation): Promise<WriteResult<{ slot: Slot; reservation: Reservation }>>;
  /** CC-3 en el panel: cambia la capacidad solo si la versión sigue vigente y no queda por debajo de lo reservado. */
  updateCapacity(input: { slotId: string; version: number; capacity: number }): Promise<WriteResult<Slot>>;

  /**
   * Cancela la reserva si `puede(reserva)` lo permite: la borra y devuelve sus
   * cupos a la franja (sube la versión). Indivisible: dos cancelaciones
   * simultáneas de la misma reserva liberan los cupos una sola vez.
   */
  cancel(
    reservationId: string,
    puede: (r: Reservation) => boolean,
  ): Promise<{ ok: true; value: { reservation: Reservation; slot: Slot } } | { ok: false; code: CancelFailure }>;

  /** La cuenta de Google con ese `sub`, o `null`. */
  findGoogleAccount(googleSub: string): Promise<GoogleAccount | null>;
  /** Un solo INSERT: si dos pestañas entran a la vez con la misma cuenta, gana una. */
  insertGoogleAccount(a: GoogleAccount): Promise<InsertGoogleResult>;
  findGoogleAccountById(accountId: string): Promise<GoogleAccount | null>;
  businessProfileOf(accountId: string): Promise<BusinessProfile | null>;
  /** Un solo INSERT: la cuenta y el NIT son únicos. Indivisible ante pedidos simultáneos. */
  insertBusinessProfile(p: BusinessProfile): Promise<InsertBusinessResult>;

  /** La cuenta dueña de un nombre (clave normalizada), o `null`. */
  findAccount(nameKey: string): Promise<Account | null>;
  /** Inserta la cuenta solo si ni el nombre ni el id están tomados; indivisible. */
  insertAccount(a: Account): Promise<InsertAccountResult>;

  reservationsOfUser(userId: string): Promise<Reservation[]>;
  reservationsOfPlace(placeId: string): Promise<Reservation[]>;

  close?(): Promise<void>;
}
