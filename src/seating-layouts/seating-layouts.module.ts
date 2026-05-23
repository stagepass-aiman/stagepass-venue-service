import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VenuesModule } from '../venues/venues.module';
import { SeatingLayoutsController } from './seating-layouts.controller';
import { SeatingLayoutsService } from './seating-layouts.service';
import { SeatingLayout, SeatingLayoutSchema } from './schemas/seating-layout.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: SeatingLayout.name, schema: SeatingLayoutSchema }]),
    VenuesModule, // imports VenuesService for tenant checks
  ],
  controllers: [SeatingLayoutsController],
  providers: [SeatingLayoutsService],
  exports: [SeatingLayoutsService],
})
export class SeatingLayoutsModule {}
