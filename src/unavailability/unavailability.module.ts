import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VenuesModule } from '../venues/venues.module';
import { UnavailabilityController } from './unavailability.controller';
import { UnavailabilityService } from './unavailability.service';
import { UnavailabilityWindow, UnavailabilityWindowSchema } from './schemas/unavailability-window.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UnavailabilityWindow.name, schema: UnavailabilityWindowSchema },
    ]),
    VenuesModule,
  ],
  controllers: [UnavailabilityController],
  providers: [UnavailabilityService],
  exports: [MongooseModule], // exported so VenueBookingsModule can import the model
})
export class UnavailabilityModule {}
