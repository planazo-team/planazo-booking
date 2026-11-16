import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
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
import {
  claveNombre,
  CORREO,
  CUENTA_GOOGLE,
  DISPOSITIVO,
  GOOGLE_SUB,
  limpiarNombre,
  NOMBRE,
  nitValido,
  nombreDeGoogle,
  razonSocialValida,
  telefonoValido,
  TERMINOS_NEGOCIO,
} from './cuentas';
import { armarLugar, type NewPlaceInput } from './new-place';
import { cifrar, descifrar, generarSecreto, uriOtpauth, verificarCodigo } from './dos-pasos';
import { BOOKING_STORE, type BookingStore, type StoredPlace, type WriteFailure } from './store/booking.store';
import { publico } from './store/memory.store';
import { cancelaciones, rechazosReserva, reservas } from '../common/metrics';

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
/** Códigos equivocados seguidos antes de bloquear y por cuánto tiempo (ESC-01). */
const MAX_FALLOS_2FA = 5;
const BLOQUEO_2FA_MS = 5 * 60_000;

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
   * POST /accounts/claim { name, deviceId } → { accountId, name }. Solo lo llama
   * el gateway al hacer login (la ruta no se publica).
   *
   * Cada nombre es una cuenta: el primer navegador que lo usa se queda con él.
   * Ese mismo navegador vuelve a entrar con su nombre cuando quiera; otro
   * navegador recibe 409 NOMBRE_EN_USO con una sugerencia libre. Y un mismo
   * navegador con dos nombres son dos cuentas distintas (Juan no hereda el
   * negocio de Pedro por compartir el computador).
   */
  async claimAccount(input: { name?: string; deviceId?: string }): Promise<{ accountId: string; name: string }> {
    const name = limpiarNombre(input?.name ?? '');
    const deviceId = String(input?.deviceId ?? '');
    if (!NOMBRE.test(name)) {
      throw new BadRequestException({ code: 'NOMBRE_INVALIDO', message: 'Escribe un nombre de 2 a 30 letras (sin símbolos raros).' });
    }
    if (!DISPOSITIVO.test(deviceId)) {
      throw new BadRequestException({ code: 'DISPOSITIVO_INVALIDO', message: 'Falta el identificador del dispositivo.' });
    }
    const nameKey = claveNombre(name);

    for (let intento = 0; intento < 4; intento++) {
      const cuenta = await this.store.findAccount(nameKey);
      if (cuenta) {
        if (cuenta.deviceId === deviceId) return { accountId: cuenta.accountId, name: cuenta.name };
        const sugerencia = await this.nombreLibre(name);
        throw new ConflictException({
          code: 'NOMBRE_EN_USO',
          message: `«${cuenta.name}» ya lo está usando otra persona.${sugerencia ? ` Prueba con «${sugerencia}».` : ''}`,
          suggestion: sugerencia,
        });
      }

      // El id que este navegador usaba antes de los nombres únicos (sus
      // reservas y su negocio) solo se hereda si esos datos son de esta misma
      // persona: mismo nombre en el negocio y en todas sus reservas. Si no,
      // «Pedro 2» vería las reservas que hizo «pedro» en este computador.
      const negocio = await this.store.placeOwnedBy(`n-${deviceId}`);
      const reservas = await this.store.reservationsOfUser(`c-${deviceId}`);
      const heredaId =
        (!negocio?.ownerName || claveNombre(negocio.ownerName) === nameKey) &&
        reservas.every((r) => claveNombre(r.userName) === nameKey);
      const candidatos = heredaId ? [deviceId, `${deviceId}${codigo(6)}`] : [`${deviceId}${codigo(6)}`];
      for (const accountId of candidatos) {
        const r = await this.store.insertAccount({ nameKey, name, accountId, deviceId });
        if (r === 'ok') return { accountId, name };
        if (r === 'NOMBRE_TOMADO') break; // alguien lo tomó en este instante: vuelve a mirar
      }
    }
    throw new ConflictException({ code: 'NOMBRE_EN_USO', message: `«${name}» ya lo está usando otra persona.` });
  }

  /**
   * POST /accounts/google { googleSub, email, name } → { accountId, name, email, negocio }.
   * Solo lo llama el gateway, después de verificar el ID token de Google.
   * La primera vez crea la cuenta. `negocio` dice si ya activó el modo negocio.
   */
  async googleAccount(input: { googleSub?: string; email?: string; name?: string }) {
    const googleSub = String(input?.googleSub ?? '');
    const email = String(input?.email ?? '').trim().toLowerCase();
    if (!GOOGLE_SUB.test(googleSub) || !CORREO.test(email)) {
      throw new BadRequestException({ code: 'CUENTA_GOOGLE_INVALIDA', message: 'La identidad de Google llegó incompleta.' });
    }
    let cuenta = await this.store.findGoogleAccount(googleSub);
    for (let intento = 0; !cuenta && intento < 4; intento++) {
      const nueva = { googleSub, email, name: nombreDeGoogle(input?.name ?? '', email), accountId: `g${codigo(12)}` };
      const r = await this.store.insertGoogleAccount(nueva);
      if (r === 'ok') cuenta = nueva;
      else if (r === 'YA_EXISTE') cuenta = await this.store.findGoogleAccount(googleSub);
    }
    if (!cuenta) throw new ConflictException({ code: 'CUENTA_NO_CREADA', message: 'No pudimos crear tu cuenta. Intenta de nuevo.' });
    return {
      ...this.publicaCuenta(cuenta),
      negocio: !!(await this.store.businessProfileOf(cuenta.accountId)),
      dosPasos: !!(await this.store.dosPasosDe(cuenta.accountId))?.activo,
    };
  }

  /** GET /accounts/:accountId → { accountId, name, email, negocio }. Para cambiar de modo. */
  async accountById(accountId: string) {
    const cuenta = CUENTA_GOOGLE.test(accountId) ? await this.store.findGoogleAccountById(accountId) : null;
    if (!cuenta) throw new NotFoundException({ code: 'CUENTA_NO_EXISTE', message: 'La cuenta no existe.' });
    return {
      ...this.publicaCuenta(cuenta),
      negocio: !!(await this.store.businessProfileOf(accountId)),
      dosPasos: !!(await this.store.dosPasosDe(accountId))?.activo,
    };
  }

  // ---------------------------------------------------------------------------
  // Verificación en dos pasos del modo negocio (TOTP con app autenticadora).
  // Solo las llama el gateway, con su llave. ESC-01: autenticación multifactor.
  // ---------------------------------------------------------------------------

  /** GET /accounts/:accountId/2fa → { activo } */
  async estadoDosPasos(accountId: string) {
    await this.cuentaExistente(accountId);
    return { activo: !!(await this.store.dosPasosDe(accountId))?.activo };
  }

  /**
   * POST /accounts/:accountId/2fa/iniciar → { otpauthUri, secreto }.
   * Genera un secreto nuevo (sin activar) para mostrarlo como QR. Solo para
   * cuentas con el negocio registrado y que todavía no lo tengan activo.
   */
  async iniciarDosPasos(accountId: string) {
    const cuenta = await this.cuentaExistente(accountId);
    if (!(await this.store.businessProfileOf(accountId))) {
      throw new ForbiddenException({ code: 'NEGOCIO_NO_REGISTRADO', message: 'Primero registra tu negocio.' });
    }
    const secreto = generarSecreto();
    if (!(await this.store.guardarDosPasosPendiente(accountId, cifrar(secreto)))) {
      throw new ConflictException({ code: '2FA_YA_ACTIVO', message: 'La verificación en dos pasos ya está activa.' });
    }
    return { otpauthUri: uriOtpauth(secreto, cuenta.email), secreto };
  }

  /** POST /accounts/:accountId/2fa/confirmar { codigo } → { activo: true }. El primer código de la app la activa. */
  async confirmarDosPasos(accountId: string, codigo: unknown) {
    await this.cuentaExistente(accountId);
    const d = await this.store.dosPasosDe(accountId);
    if (!d) throw new ConflictException({ code: '2FA_NO_INICIADO', message: 'Primero genera el código QR.' });
    if (d.activo) throw new ConflictException({ code: '2FA_YA_ACTIVO', message: 'La verificación en dos pasos ya está activa.' });
    const paso = await this.comprobarCodigo(accountId, d, codigo);
    await this.store.activarDosPasos(accountId, paso);
    return { activo: true };
  }

  /** POST /accounts/:accountId/2fa/verificar { codigo } → { ok: true }. Para entrar en modo negocio. */
  async verificarDosPasos(accountId: string, codigo: unknown) {
    await this.cuentaExistente(accountId);
    const d = await this.store.dosPasosDe(accountId);
    if (!d?.activo) throw new ConflictException({ code: '2FA_NO_ACTIVO', message: 'Esta cuenta no tiene activa la verificación en dos pasos.' });
    const paso = await this.comprobarCodigo(accountId, d, codigo);
    // Un código vale una sola vez, aunque siga vigente y lo use otra réplica.
    if (!(await this.store.usarPasoDosPasos(accountId, paso))) {
      throw new HttpException({ code: '2FA_INVALIDO', message: 'Ese código ya se usó. Espera el siguiente en tu app.' }, 401);
    }
    return { ok: true };
  }

  private async cuentaExistente(accountId: string) {
    const cuenta = CUENTA_GOOGLE.test(accountId) ? await this.store.findGoogleAccountById(accountId) : null;
    if (!cuenta) throw new NotFoundException({ code: 'CUENTA_NO_EXISTE', message: 'La cuenta no existe.' });
    return cuenta;
  }

  /** Verifica el código; tras MAX_FALLOS_2FA seguidos bloquea la cuenta BLOQUEO_2FA_MS. Devuelve el paso que coincidió. */
  private async comprobarCodigo(accountId: string, d: { secretoCifrado: string; bloqueadoHasta: number }, codigo: unknown): Promise<number> {
    const ahora = Date.now();
    if (d.bloqueadoHasta > ahora) throw this.bloqueado(d.bloqueadoHasta - ahora);
    const paso = verificarCodigo(descifrar(d.secretoCifrado), String(codigo ?? ''), ahora);
    if (paso !== null) return paso;
    const tras = await this.store.fallarDosPasos(accountId, MAX_FALLOS_2FA, ahora + BLOQUEO_2FA_MS);
    if (tras && tras.bloqueadoHasta > ahora) throw this.bloqueado(tras.bloqueadoHasta - ahora);
    throw new HttpException({ code: '2FA_INVALIDO', message: 'El código no es correcto. Revisa tu app autenticadora.' }, 401);
  }

  private bloqueado(restanteMs: number) {
    const min = Math.max(1, Math.ceil(restanteMs / 60_000));
    return new HttpException(
      { code: '2FA_BLOQUEADO', message: `Demasiados códigos equivocados. Intenta de nuevo en ${min} min.` },
      429,
    );
  }

  private publicaCuenta(c: { accountId: string; name: string; email: string }) {
    return { accountId: c.accountId, name: c.name, email: c.email };
  }

  /**
   * POST /accounts/:accountId/negocio { legalName, nit, phone, acceptTerms } → { accountId, negocio, legalName }.
   * Activa el modo negocio. Todo se valida aquí, no en el navegador: razón
   * social, NIT con su dígito de verificación (DIAN), teléfono colombiano y la
   * aceptación de los términos. El NIT es único entre todas las cuentas.
   */
  async registerBusiness(accountId: string, input: { legalName?: string; nit?: string; phone?: string; acceptTerms?: boolean }) {
    if (!CUENTA_GOOGLE.test(accountId) || !(await this.store.findGoogleAccountById(accountId))) {
      throw new NotFoundException({ code: 'CUENTA_NO_EXISTE', message: 'La cuenta no existe.' });
    }
    const legalName = razonSocialValida(input?.legalName ?? '');
    if (!legalName) throw new BadRequestException({ code: 'RAZON_SOCIAL_INVALIDA', message: 'Escribe la razón social del negocio (3 a 120 caracteres).' });
    const nit = nitValido(input?.nit ?? '');
    if (!nit) {
      throw new BadRequestException({ code: 'NIT_INVALIDO', message: 'El NIT no es válido: revisa los números y el dígito de verificación.' });
    }
    const phone = telefonoValido(input?.phone ?? '');
    if (!phone) throw new BadRequestException({ code: 'TELEFONO_INVALIDO', message: 'Escribe un celular o fijo de Colombia (10 dígitos).' });
    if (input?.acceptTerms !== true) {
      throw new BadRequestException({ code: 'TERMINOS_REQUERIDOS', message: 'Debes aceptar los términos para negocios.' });
    }

    const r = await this.store.insertBusinessProfile({ accountId, legalName, nit, phone, termsVersion: TERMINOS_NEGOCIO, acceptedAt: Date.now() });
    if (r === 'NIT_EN_USO') {
      throw new ConflictException({ code: 'NIT_EN_USO', message: 'Ese NIT ya está registrado en otra cuenta. Si es tuyo, escríbenos.' });
    }
    // YA_ES_NEGOCIO: el registro ya existía (doble clic o reintento); se responde igual.
    const perfil = await this.store.businessProfileOf(accountId);
    return { accountId, negocio: true, legalName: perfil?.legalName ?? legalName };
  }

  /** «Juan 2», «Juan 3»… el primero que esté libre. */
  private async nombreLibre(name: string): Promise<string | null> {
    for (let n = 2; n < 100; n++) {
      const candidato = `${name.slice(0, 30 - String(n).length - 1)} ${n}`;
      if (!(await this.store.findAccount(claveNombre(candidato)))) return candidato;
    }
    return null;
  }

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
    const stored: StoredPlace = { ...place, ownerId: who.userId, ownerName: who.userName };
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
    const zona = await this.emitInventory(slot);
    reservas.inc({ zona: zona ?? 'desconocida' });
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
    const zona = await this.emitInventory(slot);
    cancelaciones.inc({ zona: zona ?? 'desconocida' });
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
    rechazosReserva.inc({ motivo: code, donde });
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
  /** Avisa el cambio de inventario y devuelve la zona del lugar (para las métricas). */
  private async emitInventory(slot: Slot): Promise<string | undefined> {
    const p = await this.store.getPlace(slot.placeId);
    if (!p) return undefined;
    await this.bus.publish('INV.UPDATE', { placeId: p.id, slot }, [`place:${p.id}`]);
    await this.bus.publish('PLACE.UPDATE', { placeId: p.id, freeSeats: await this.store.freeSeats(p.id) }, [
      `zone:${p.zone}`,
    ]);
    return p.zone;
  }
}
