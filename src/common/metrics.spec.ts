import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { cancelaciones, rechazosReserva, reservas, medirHttp, registro, rutaDe, servidorDeMetricas } from './metrics';

describe('métricas para Prometheus', () => {
  it('etiqueta la ruta con su plantilla, nunca con ids reales', () => {
    expect(rutaDe({ route: { path: '/places/:id' }, baseUrl: '' } as unknown as Request)).toBe('/places/:id');
    expect(rutaDe({} as Request)).toBe('sin_ruta');
  });

  it('mide cada petición al terminar', async () => {
    const res = new EventEmitter() as unknown as Response;
    (res as unknown as { statusCode: number }).statusCode = 200;
    const next = jest.fn();
    medirHttp()({ method: 'GET', route: { path: '/health' } } as unknown as Request, res, next);
    (res as unknown as EventEmitter).emit('finish');
    expect(next).toHaveBeenCalled();
    const linea = (await registro.metrics()).split(/\r?\n/).find((l) => l.startsWith('http_request_duration_seconds_count') && l.includes('route="/health"'));
    expect(linea).toContain('status="200"');
  });

  it('registra los contadores de negocio', async () => {
    reservas.inc({ zona: 'zona-g' });
    cancelaciones.inc({ zona: 'zona-t' });
    rechazosReserva.inc({ motivo: 'VERSION_CONFLICT', donde: 'reserva' });
    const texto = await registro.metrics();
    expect(texto).toContain('planazo_reservas_total');
    expect(texto).toContain('planazo_reservas_canceladas_total');
    expect(texto).toContain('planazo_reservas_rechazadas_total');
  });

  it('el servidor de métricas responde /metrics y nada más', async () => {
    const srv = servidorDeMetricas(0);
    await new Promise((r) => srv.once('listening', r));
    const { port } = srv.address() as AddressInfo;
    const ok = await fetch(`http://[::1]:${port}/metrics`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('process_cpu_user_seconds_total');
    expect((await fetch(`http://[::1]:${port}/otra`)).status).toBe(404);
    await new Promise((r) => srv.close(r));
  });
});
