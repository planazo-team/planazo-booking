import { Logger, Module } from '@nestjs/common';
import { config } from '../config';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { BOOKING_STORE } from './store/booking.store';
import { MemoryBookingStore } from './store/memory.store';
import { PgBookingStore } from './store/pg.store';

// BusService llega por BusModule, que es global.
@Module({
  controllers: [BookingController],
  providers: [
    BookingService,
    {
      // Con DATABASE_URL todo vive en PostgreSQL; sin ella, en memoria (solo desarrollo y tests).
      provide: BOOKING_STORE,
      useFactory: () => {
        if (config.databaseUrl) return new PgBookingStore(config.databaseUrl);
        new Logger('BookingStore').warn('DATABASE_URL no está definida: lugares y reservas viven en memoria (se pierden al reiniciar).');
        return new MemoryBookingStore();
      },
    },
  ],
})
export class BookingModule {}
