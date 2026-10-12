import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Identity, Roles } from '../common/identity';
import { BookingService } from './booking.service';
import type { Category, Zone } from './booking.types';
import type { NewPlaceInput } from './new-place';

/** Nombre del usuario tal como lo reenvía el gateway (codificado con encodeURIComponent). */
function nombreDesdeRequest(req: Request, fallback: string): string {
  const raw = req.headers['x-user-name'];
  const valor = Array.isArray(raw) ? raw[0] : raw;
  if (!valor) return fallback;
  try {
    return decodeURIComponent(valor);
  } catch {
    return valor;
  }
}

/**
 * Rutas de booking según docs/arquitectura.md. El gateway quita el prefijo /api:
 *   GET   /places                              mapa
 *   POST  /places                              negocio: crea su lugar (uno por cuenta)
 *   GET   /places/owned                        negocio: su lugar, o 404
 *   GET   /places/:id                          ficha
 *   GET   /places/:id/reservations             panel: reservas entrantes
 *   PATCH /places/:id/slots/:slotId            panel: capacidad de una franja (CC-3)
 *   POST  /reservations                        reservar (CC-3)
 *   GET   /reservations/mine                   mis reservas
 *   DELETE /reservations/:id                   cancelar (quien reservó o el lugar)
 *   POST  /events                              panel: publicar evento
 */
@Controller()
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  @Get('places')
  listPlaces(@Query('zone') zone?: Zone, @Query('category') category?: Category) {
    return this.booking.listPlaces({ zone, category });
  }

  @Roles('negocio')
  @Post('places')
  createPlace(@Identity() who: Identity, @Req() req: Request, @Body() body: NewPlaceInput) {
    return this.booking.createPlace({ ...who, userName: nombreDesdeRequest(req, who.userId) }, body ?? {});
  }

  // Va antes de `places/:id` para que "owned" no se lea como un id.
  @Roles('negocio')
  @Get('places/owned')
  ownedPlace(@Identity() who: Identity) {
    return this.booking.ownedPlace(who);
  }

  @Get('places/:id')
  getPlace(@Param('id') id: string) {
    return this.booking.getPlace(id);
  }

  @Roles('negocio')
  @Get('places/:id/reservations')
  placeReservations(@Identity() who: Identity, @Param('id') id: string) {
    return this.booking.placeReservations(who, id);
  }

  @Roles('negocio')
  @Patch('places/:id/slots/:slotId')
  updateSlot(
    @Identity() who: Identity,
    @Param('id') placeId: string,
    @Param('slotId') slotId: string,
    @Body() body: { capacity: number; version: number },
  ) {
    return this.booking.updateSlotCapacity(who, { placeId, slotId, capacity: body?.capacity, version: body?.version });
  }

  @Roles('cliente')
  @Post('reservations')
  reserve(
    @Identity() who: Identity,
    @Req() req: Request,
    @Body() body: { slotId: string; people: number; version: number },
  ) {
    return this.booking.reserve(
      { ...who, userName: nombreDesdeRequest(req, who.userId) },
      { slotId: body?.slotId, people: body?.people, version: body?.version },
    );
  }

  @Delete('reservations/:id')
  cancel(@Identity() who: Identity, @Param('id') id: string) {
    return this.booking.cancel(who, id);
  }

  @Get('reservations/mine')
  myReservations(@Identity() who: Identity) {
    return this.booking.myReservations(who.userId);
  }

  @Roles('negocio')
  @Post('events')
  createEvent(
    @Identity() who: Identity,
    @Body() body: { placeId: string; title: string; startsAt: string; capacity: number },
  ) {
    return this.booking.createEvent(who, {
      placeId: body?.placeId,
      title: body?.title,
      startsAt: body?.startsAt,
      capacity: body?.capacity,
    });
  }
}
