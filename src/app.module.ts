import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import configuration, { validationSchema } from './config/configuration';
import { HealthModule } from './health/health.module';
import { JwksModule } from './jwks/jwks.module';
import { KafkaModule } from './kafka/kafka.module';
import { OutboxModule } from './outbox/outbox.module';
import { SeatingLayoutsModule } from './seating-layouts/seating-layouts.module';
import { UnavailabilityModule } from './unavailability/unavailability.module';
import { VenueBookingsModule } from './venue-bookings/venue-bookings.module';
import { VenuesModule } from './venues/venues.module';

@Module({
  imports: [
    // ConfigModule must be first — other modules read env via ConfigService.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
      validationOptions: { abortEarly: true },
    }),

    // MongoDB with async factory so we can inject ConfigService.
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('mongodb.uri'),
        // directConnection=true is required for single-node replica sets (rs0)
        // used in local development. Without it, the driver tries to discover
        // all replica set members and may time out on a single-node setup.
        directConnection: true,
      }),
    }),

    ScheduleModule.forRoot(), // required for @Cron in OutboxPublisher

    // @Global modules — available everywhere without explicit import.
    JwksModule,
    KafkaModule,

    // Infrastructure — must be before feature modules that depend on OutboxService.
    OutboxModule,

    // Feature modules.
    HealthModule,
    VenuesModule,
    SeatingLayoutsModule,
    VenueBookingsModule,
    UnavailabilityModule,
  ],
})
export class AppModule {}
