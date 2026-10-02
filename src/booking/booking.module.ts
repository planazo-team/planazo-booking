import { Module } from '@nestjs/common';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

// BusService llega por BusModule, que es global.
@Module({
  controllers: [BookingController],
  providers: [BookingService],
})
export class BookingModule {}
