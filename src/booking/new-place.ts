import { BadRequestException } from '@nestjs/common';
import type { Category, PlaceBase, Slot, Zone } from './booking.types';

/**
 * Reglas para que un negocio cree su lugar desde la app: qué se valida, en
 * qué zona queda y con qué franjas arranca. El negocio después ajusta los
 * cupos desde su panel (con el mismo lock optimista de siempre).
 */

export const CATEGORIES: Category[] = ['restaurante', 'bar', 'discoteca', 'hotel', 'evento', 'aire-libre'];

const CENTROS: Record<Zone, [number, number]> = {
  'zona-g': [4.6553, -74.0566],
  'zona-t': [4.6672, -74.0536],
};

/** Caja que cubre el piloto (Chapinero, entre la 60 y la 93). Fuera de ella no se aceptan lugares. */
const CAJA = { latMin: 4.645, latMax: 4.682, lngMin: -74.07, lngMax: -74.035 };

/** Franjas con las que arranca cada categoría: [hora, capacidad]. */
const FRANJAS: Record<Category, Array<[string, number]>> = {
  restaurante: [['19:00', 16], ['20:30', 16], ['22:00', 12]],
  bar: [['20:00', 20], ['22:00', 20], ['23:30', 16]],
  discoteca: [['22:00', 60], ['00:00', 60]],
  evento: [['20:00', 50], ['22:30', 40]],
  hotel: [],
  'aire-libre': [],
};

const DESCRIPCION: Record<Category, string> = {
  restaurante: 'Cocina de la casa y mesas para compartir.',
  bar: 'Cócteles, buena música y ambiente para arrancar la noche.',
  discoteca: 'Pista, DJ y rumba hasta tarde.',
  hotel: 'Hospedaje a pasos de la zona.',
  evento: 'Shows en vivo con cupo limitado.',
  'aire-libre': 'Plan al aire libre, sin reserva.',
};

/** La zona más cercana a la ubicación que eligió el negocio en el mapa. */
export function zonaDe(lat: number, lng: number): Zone {
  const d = (z: Zone) => (CENTROS[z][0] - lat) ** 2 + (CENTROS[z][1] - lng) ** 2;
  return d('zona-g') <= d('zona-t') ? 'zona-g' : 'zona-t';
}

export interface NewPlaceInput {
  name?: unknown;
  category?: unknown;
  lat?: unknown;
  lng?: unknown;
  description?: unknown;
  priceLevel?: unknown;
  cover?: unknown;
}

const malo = (code: string, message: string) => new BadRequestException({ code, message });

/** Valida el cuerpo de POST /places y arma el lugar y sus franjas iniciales. */
export function armarLugar(id: string, input: NewPlaceInput): { place: PlaceBase; slots: Slot[] } {
  const name = String(input?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 40) throw malo('NOMBRE_INVALIDO', 'El nombre debe tener entre 3 y 40 caracteres.');

  const category = String(input?.category ?? '') as Category;
  if (!CATEGORIES.includes(category)) throw malo('CATEGORIA_INVALIDA', 'Elige una categoría de la lista.');

  const lat = Number(input?.lat);
  const lng = Number(input?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < CAJA.latMin || lat > CAJA.latMax || lng < CAJA.lngMin || lng > CAJA.lngMax) {
    throw malo('UBICACION_FUERA_DEL_PILOTO', 'Por ahora Planazo solo cubre la Zona G y la Zona T: ubica tu lugar dentro del mapa del piloto.');
  }

  const description = String(input?.description ?? '').trim().slice(0, 200) || DESCRIPCION[category];
  const priceLevel = Number(input?.priceLevel ?? 2);
  if (![0, 1, 2, 3].includes(priceLevel)) throw malo('PRECIO_INVALIDO', 'El nivel de precio va de 0 (gratis) a 3.');

  const coverRaw = input?.cover == null ? null : String(input.cover);
  if (coverRaw !== null && !/^[a-z0-9-]{1,40}$/.test(coverRaw)) throw malo('PORTADA_INVALIDA', 'La portada no es válida.');

  const place: PlaceBase = {
    id,
    name,
    category,
    zone: zonaDe(lat, lng),
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    description,
    priceLevel: priceLevel as PlaceBase['priceLevel'],
    cover: coverRaw,
  };
  const slots: Slot[] = FRANJAS[category].map(([startsAt, capacity], i) => ({
    id: `${id}-s${i + 1}`,
    placeId: id,
    startsAt,
    capacity,
    taken: 0,
    version: 1,
  }));
  return { place, slots };
}
