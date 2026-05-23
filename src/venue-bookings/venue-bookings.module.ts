import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OutboxModule } from '../outbox/outbox.module';
import { VenuesModule } from '../venues/venues.module';
import { UnavailabilityWindow, UnavailabilityWindowSchema } from '../unavailability/schemas/unavailability-window.schema';
import { VenueBookingsController } from './venue-bookings.controller';
import { VenueBookingsService } from './venue-bookings.service';
import { VenueBooking, VenueBookingSchema } from './schemas/venue-booking.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VenueBooking.name, schema: VenueBookingSchema },
      // VenueBookingsService queries unavailability_windows for overlap checks.
      { name: UnavailabilityWindow.name, schema: UnavailabilityWindowSchema },
    ]),
    OutboxModule,
    VenuesModule,
  ],
  controllers: [VenueBookingsController],
  providers: [VenueBookingsService],
})
export class VenueBookingsModule {}
