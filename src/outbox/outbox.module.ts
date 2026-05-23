import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OutboxPublisher } from './outbox.publisher';
import { OutboxService } from './outbox.service';
import { Outbox, OutboxSchema } from './schemas/outbox.schema';

/**
 * OutboxModule is a top-level sibling module (not nested inside venues/ or venue-bookings/).
 *
 * Why top-level: The Outbox pattern is a cross-cutting infrastructure concern.
 * VenuesService, SeatingLayoutsService, and VenueBookingsService all write to the
 * outbox — it doesn't belong to any single domain. Nesting it inside venues/ would
 * create an upward dependency (venue-bookings/ importing from venues/) which violates
 * module cohesion. As a sibling, any feature module can import OutboxModule cleanly.
 *
 * OutboxService is exported so feature modules can inject it.
 * OutboxPublisher is not exported — it's an internal background task.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: Outbox.name, schema: OutboxSchema }])],
  providers: [OutboxService, OutboxPublisher],
  exports: [OutboxService],
})
export class OutboxModule {}
