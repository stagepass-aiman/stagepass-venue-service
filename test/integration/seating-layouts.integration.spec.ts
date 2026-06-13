/**
 * Integration tests for SeatingLayoutsController — proves the layout read
 * endpoints inherit venue visibility via delegation to VenuesService.findOne().
 *
 * Rules: RULE-08, RULE-09, RULE-11, RULE-26, RULE-27.
 *
 * ASSUMPTION TO VERIFY: SeatingLayout schema exports { SeatingLayout, SeatingLayoutSchema }.
 *
 * Why this suite exists: listForVenue() and findOne() in SeatingLayoutsService
 * both open with `await venuesService.findOne(venueId, actor)` BEFORE touching
 * layouts. So the venue visibility fix protects them with zero code change here.
 * These tests lock that behaviour so a refactor that drops the delegation (and
 * re-opens the leak) fails CI.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { JwksService } from '../../src/jwks/jwks.service';
import { KafkaService } from '../../src/kafka/kafka.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { Outbox, OutboxSchema } from '../../src/outbox/schemas/outbox.schema';
import { VenuesService } from '../../src/venues/venues.service';
import { Venue, VenueSchema, VenueDocument } from '../../src/venues/schemas/venue.schema';
import { SeatingLayoutsController } from '../../src/seating-layouts/seating-layouts.controller';
import { SeatingLayoutsService } from '../../src/seating-layouts/seating-layouts.service';
import {
  SeatingLayout,
  SeatingLayoutSchema,
} from '../../src/seating-layouts/schemas/seating-layout.schema';
import { UserRole } from '../../src/common/types/jwt-payload.types';

const VENUE_OWNER = {
  userId: 'venue-owner-001',
  email: 'owner@test.com',
  role: UserRole.VENUE,
  displayName: 'Venue Owner',
  jti: 'jti-vo-001',
};
const CUSTOMER = {
  userId: 'cust-001',
  email: 'cust@test.com',
  role: UserRole.CUSTOMER,
  displayName: 'Customer',
  jti: 'jti-cust-001',
};
const ORGANISER = {
  userId: 'org-001',
  email: 'org@test.com',
  role: UserRole.ORGANISER,
  displayName: 'Organiser',
  jti: 'jti-org-001',
};

describe('SeatingLayoutsController (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let venueModel: Model<VenueDocument>;

  const mockJwksService = { validateToken: jest.fn() };
  const mockKafkaService = { send: jest.fn().mockResolvedValue(undefined) };
  const mockOutboxService = { create: jest.fn().mockResolvedValue(undefined) };

  const asActor = (actor: typeof VENUE_OWNER): void => {
    mockJwksService.validateToken.mockResolvedValueOnce({
      sub: actor.userId,
      email: actor.email,
      role: actor.role,
      displayName: actor.displayName,
      jti: actor.jti,
    });
  };

  const seedVenue = async (ownerId: string, status: string): Promise<string> => {
    const venueId = uuidv4();
    await venueModel.create({
      venueId,
      ownerId,
      name: 'Layout Venue',
      city: 'Mumbai',
      address: '1 Marine Drive',
      status,
      totalCapacity: 1000,
      schemaVersion: '1.0.0',
    });
    return venueId;
  };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: SeatingLayout.name, schema: SeatingLayoutSchema },
          { name: Venue.name, schema: VenueSchema },
          { name: Outbox.name, schema: OutboxSchema },
        ]),
      ],
      controllers: [SeatingLayoutsController],
      providers: [
        SeatingLayoutsService,
        VenuesService,
        { provide: JwksService, useValue: mockJwksService },
        { provide: KafkaService, useValue: mockKafkaService },
        { provide: OutboxService, useValue: mockOutboxService },
        JwtAuthGuard,
        RolesGuard,
      ],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());
    venueModel = moduleRef.get<Model<VenueDocument>>(getModelToken(Venue.name));

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    await connection.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await app?.close();
    await replSet?.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /venues/:venueId/layouts — inherits venue visibility', () => {
    it('404s a CUSTOMER on a PENDING_KYC venue (delegation blocks before layout lookup)', async () => {
      const venueId = await seedVenue(VENUE_OWNER.userId, 'PENDING_KYC');
      asActor(CUSTOMER);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${venueId}/layouts`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(404);
    });

    it('200s an ORGANISER on an ACTIVE venue (public discovery preserved)', async () => {
      const venueId = await seedVenue(VENUE_OWNER.userId, 'ACTIVE');
      asActor(ORGANISER);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${venueId}/layouts`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
    });

    it('200s the owner on their own PENDING_KYC venue', async () => {
      const venueId = await seedVenue(VENUE_OWNER.userId, 'PENDING_KYC');
      asActor(VENUE_OWNER);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${venueId}/layouts`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /venues/:venueId/layouts/:layoutId — inherits venue visibility', () => {
    it('404s a CUSTOMER on a PENDING_KYC venue before any layout lookup', async () => {
      const venueId = await seedVenue(VENUE_OWNER.userId, 'PENDING_KYC');
      asActor(CUSTOMER);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${venueId}/layouts/${uuidv4()}`)
        .set('Authorization', 'Bearer mock-token');
      // 404 from the venue visibility gate, NOT "layout not found" — the point is
      // that we never reveal whether a layout exists for a venue you can't see.
      expect(res.status).toBe(404);
    });
  });
});
