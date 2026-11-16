# planazo-booking

**Inventario y reservas.** Fuente de verdad de la disponibilidad: todo lo que tenga que ver con *cuántos cupos quedan* pasa por aquí.

| | |
|---|---|
| **Dueño** | Fabián Andrade |
| **Retos** | **CC-3** (cupos limitados) · **RT-1** (emite los cambios de disponibilidad) |
| **Datos** | PostgreSQL (esquema `booking`) con `DATABASE_URL`; en memoria sin ella (desarrollo y tests) |
| **Producción** | Railway, solo por red privada: `http://planazo-booking.railway.internal:3001` |
| **Puerto local sugerido** | `3001` |
| **Contexto general** | [planazo-frontend/docs/contexto.md](https://github.com/planazo-team/planazo-frontend/blob/main/docs/contexto.md) |

**Escenario 4 (Disponibilidad):** `docker compose up` en este repo levanta 2
réplicas de este servicio + un balanceador Nginx propio (`nginx.conf`),
publicado en el mismo puerto `3001` de siempre. Requiere que
`planazo-infra` ya esté arriba (crea la red compartida `planazo-net` y
`postgres-booking`/`redis`). Detalle completo:
[`planazo-infra/ESCENARIO-04-DISPONIBILIDAD.md`](https://github.com/planazo-team/planazo-infra/blob/main/ESCENARIO-04-DISPONIBILIDAD.md).

---

## Contrato con el gateway

Nadie llama a este servicio directamente: todo entra por [`planazo-api-gateway`](https://github.com/planazo-team/planazo-api-gateway). Tres reglas que hay que respetar:

1. **Las rutas aquí NO llevan el prefijo `/api`.** El gateway recibe `/api/places` y reenvía `/places`. Si expones `/api/places` aquí, el gateway pedirá `/api/api/places` y dará 404.
2. **No valides el JWT.** El gateway ya lo verificó y te pasa la identidad en headers:

   | Header | Contenido |
   |---|---|
   | `x-user-id` | `u1`…`u6` (cliente) o `b1`,`b2`,`b3` (negocio) |
   | `x-user-role` | `cliente` o `negocio` |
   | `x-user-place-id` | solo para negocio: el establecimiento que administra (`p7`, `p1`, `p8`) |

3. **Devuelve el código HTTP correcto, no lo escondas.** El gateway reenvía tu status tal cual. Un `409` tiene que llegar como `409` con un cuerpo `{ code, message }` — el frontend lo usa para explicarle al usuario qué pasó.

---

## Datos

> **Estado al 12 de octubre:** con `DATABASE_URL` todo vive en PostgreSQL (`src/booking/store/pg.store.ts`): el servicio crea el esquema `booking` al arrancar y siembra el catálogo (`src/booking/seed.ts`) sin pisar lo que ya exista. La reserva es el `UPDATE ... WHERE version = $v` de abajo dentro de una transacción, y la tabla tiene `CHECK (taken <= capacity)`: la sobreventa es imposible aunque haya varias réplicas. Sin `DATABASE_URL` usa `store/memory.store.ts` (mismo contrato, se pierde al reiniciar). Las pruebas de `booking.service.spec.ts` corren contra los dos almacenes si defines `TEST_DATABASE_URL`.

```sql
establishments (id, name, category, lat, lng, zone, photo_url)
time_slots     (id, establishment_id, starts_at, capacity, taken, version)
reservations   (id, slot_id, user_id, people, code, status, created_at)
events         (id, establishment_id, title, starts_at, capacity, taken)
```

La columna **`version`** de `time_slots` es el corazón de CC-3. No la quites ni la conviertas en `updated_at`: necesita ser un entero que el cliente pueda mandar de vuelta.

`category` toma uno de: `restaurante`, `bar`, `discoteca`, `hotel`, `evento`, `aire-libre`.
`zone` toma uno de: `zona-g`, `zona-t`.

---

## API

| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| `GET` | `/places?zone=&category=` | cliente | Lista para el mapa, con disponibilidad actual |
| `POST` | `/places` | negocio | Crea su lugar (uno por cuenta) y lo anuncia con `PLACE.CREATED` |
| `GET` | `/places/owned` | negocio | Su lugar, o `404 SIN_LUGAR` (lo usa el gateway al iniciar sesión) |
| `GET` | `/places/:id` | cliente | Ficha con franjas, cupos y la `version` de cada franja |
| `POST` | `/reservations` | cliente | `{slot_id, people, version}` → `201` o `409` |
| `GET` | `/reservations/mine` | cliente | Reservas activas con su código |
| `DELETE` | `/reservations/:id` | cliente o negocio | Cancela (quien reservó o el lugar): devuelve los cupos y publica `RESERVE.CANCELLED` |
| `GET` | `/places/:id/reservations` | negocio | Reservas entrantes de su establecimiento |
| `PATCH` | `/places/:id/slots/:sid` | negocio | Cambia capacidad; exige `version` |
| `POST` | `/events` | negocio | Publica un evento con cupo máximo |

El frontend ya consume exactamente estas rutas — ver `frontend/src/lib/api/live.ts` en [planazo-frontend](https://github.com/planazo-team/planazo-frontend).

---

## Mecanismo de CC-3 — lock optimista

Una sola sentencia verifica y escribe. **No hay `SELECT` previo**, así que no existe ventana de carrera entre leer y escribir:

```sql
UPDATE time_slots
   SET taken   = taken + $people,
       version = version + 1
 WHERE id = $slot_id
   AND version = $client_version        -- nadie lo tocó desde que lo leíste
   AND capacity - taken >= $people      -- y todavía alcanza
RETURNING version;
```

**0 filas → `409 CONFLICT`.** El cliente relee y decide si reintenta.

La misma regla aplica al panel del negocio: si dos dispositivos del staff editan la misma franja, el segundo recibe `409` y debe releer. Esa es la historia `B2b` del story map.

### Por qué así y no con un lock pesimista

`SELECT ... FOR UPDATE` funcionaría, pero deja la transacción abierta mientras el usuario decide, y con mil personas mirando la misma franja se convierte en una fila de espera. El versionado no bloquea a nadie: el que pierde se entera al escribir.

---

## Eventos que emite

Se publican al bus; `planazo-realtime` los persiste con su `seq` y los difunde.

| Evento | Payload mínimo | Quién lo recibe |
|---|---|---|
| `PLACE.UPDATE` | `{ placeId, freeSeats }` | `zone:<zona>` (y `place:<id>` al crear un evento) |
| `INV.UPDATE` | `{ placeId, slot: Slot }` | `place:<id>` (ficha abierta y panel) |
| `RESERVE.OK` | la `Reservation` completa, plana | `place:<id>` y `user:<id>` |

`RESERVE.CONFLICT` está en el contrato pero no se publica todavía: el `409` llega por HTTP.

---

## Lo que NO hace

- No abre WebSockets — eso es de `realtime`.
- No conoce las promociones — eso es de `promo`.
- No sabe que existe el juego.
- No decide quién ve qué: publica el evento con su tópico y `realtime` enruta.

---

## Datos semilla

El catálogo del piloto son 12 establecimientos de Zona G y Zona T (`p1`…`p12`) con sus franjas y eventos. Están en `frontend/src/lib/seed.ts` del repo del frontend y copiados en `src/booking/seed.ts` de este servicio, para que ambos modos (`mock` y `live`) muestren lo mismo. Se cargan al arrancar; no hay script aparte.

Establecimientos con dueño asignado: `p7` (Bar El Zaguán → `b1`), `p1` (Fideos de la Nona → `b2`), `p8` (Terraza 85 → `b3`).

---

## Variables de entorno

```bash
PORT=3001
GATEWAY_KEY=...                     # la misma del gateway; sin ella no se exige (desarrollo)
BUS_URL=redis://localhost:6379      # para publicar eventos de dominio; sin ella, no-op con warn
DATABASE_URL=postgresql://...       # sin ella, estado en memoria
```

Ver [`.env.example`](.env.example).

---

## Definition of Done

Dos criterios que **no son opcionales** en este servicio:

1. **Recurso finito:** no se da por terminada una historia de cupos sin una prueba de carga con peticiones concurrentes y **cero sobreventas**. Sugerido: k6 lanzando N reservas simultáneas contra una franja con capacidad N-5, y verificar que exactamente 5 reciben `409`.
2. **El `409` es criterio de aceptación**, no un error a ocultar: el mensaje tiene que explicar qué pasó ("ya no quedan cupos en esa franja"), nunca un error genérico.

---

## Despliegue en Railway

Ya está desplegado en el proyecto de Planazo, desde GitHub (`main`), **sin dominio público**: el gateway lo alcanza por `http://planazo-booking.railway.internal:3001`. Lo crea `planazo-infra/scripts/railway-deploy-core.sh` con `PORT=3001`, `GATEWAY_KEY` y `BUS_URL=${{Redis.REDIS_URL}}`. Cada push a `main` redespliega (y reinicia el estado en memoria).

Para persistir: agregar `DATABASE_URL=${{Postgres.DATABASE_URL}}` (usa su propio esquema `booking`, no choca con realtime ni game).
