// Tipos del contrato con el frontend (planazo-frontend/frontend/src/lib/types.ts).
// Si cambian allá, cambian aquí.

export type Zone = 'zona-g' | 'zona-t';

export type Category = 'restaurante' | 'bar' | 'discoteca' | 'hotel' | 'evento' | 'aire-libre';

export interface PlaceBase {
  id: string;
  name: string;
  category: Category;
  zone: Zone;
  lat: number;
  lng: number;
  description: string;
  priceLevel: 0 | 1 | 2 | 3;
}

/** Resumen para el mapa (GET /places). */
export interface Place extends PlaceBase {
  /** Cupos libres sumando todas las franjas. `null` si el lugar no maneja cupos. */
  freeSeats: number | null;
}

/** Franja horaria reservable. `version` es la clave del lock optimista (CC-3). */
export interface Slot {
  id: string;
  placeId: string;
  startsAt: string;
  capacity: number;
  taken: number;
  version: number;
}

export interface PlaceEvent {
  id: string;
  placeId: string;
  title: string;
  startsAt: string;
  capacity: number;
  taken: number;
}

/** Ficha completa (GET /places/:id). Las promociones las pone promo: aquí van vacías. */
export interface PlaceDetail extends Place {
  slots: Slot[];
  events: PlaceEvent[];
  promos: unknown[];
}

export interface Reservation {
  id: string;
  slotId: string;
  placeId: string;
  placeName: string;
  startsAt: string;
  people: number;
  code: string;
  userId: string;
  userName: string;
  createdAt: number;
}
