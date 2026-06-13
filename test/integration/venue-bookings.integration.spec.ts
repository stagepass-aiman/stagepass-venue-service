/**
 * Integration tests for VenueBookingsController — object-level authorization.
 *
 * Rules applied: RULE-08 (Express adapter), RULE-09 (explicit providers),
 * RULE-11 (supertest default import), RULE-26 (mongodb-memory-server),
 * RULE-27 (syncIndexes after app.init()).
 *
 * ASSUMPTIONS TO VERIFY against your repo (fix the import if the names differ):
 *  - VenueBooking schema exports { VenueBooking, VenueBookingSchema }
 *  - UnavailabilityWindow schema exports { UnavailabilityWindow, UnavailabilityWindowSchema }
 *  - JwtAuthGuard maps the validated token's `sub` → AuthenticatedUser.userId
 *    (mirrors the venues integration spec, which relies on the same mapping)
 *
 * GET /venue-bookings/:vbId authorization matrix (NFR-SEC-003 + NFR-SEC-004):
 *
 *   CUSTOMER            → 403  (wrong role; RolesGuard blocks before lookup)
 *   ORGANISER (owner)   → 200
 *   ORGANISER (other)   → 404  (correct role, non-party; existence concealed)
 *   VENUE (owns venue)  → 200
 *   VENUE (other)       → 404
 *   ADMIN               → 200
 *
 * Plus: POST /venue-bookings against a non-ACTIVE venue → 404 (was 409). A 409
 * "venue not available" would confirm the venue exists; the findOne() visibility
 * gate now yields 404 instead.
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
import { VenueBookingsController } from '../../src/venue-bookings/venue-bookings.controller';
import { VenueBookingsService } from '../../src/venue-bookings/venue-bookings.service';
import {
  VenueBooking,
  VenueBookingSchema,
} from '../../src/venue-bookings/schemas/venue-booking.schema';
import {
  UnavailabilityWindow,
  UnavailabilityWindowSchema,
} from '../../src/unavailability/schemas/unavailability-window.schema';
import { UserRole } from '../../src/common/types/jwt-payload.types';

const VENUE_OWNER = {
  userId: 'venue-owner-001',
  email: 'owner@test.com',
  role: UserRole.VENUE,
  displayName: 'Venue Owner',
  jti: 'jti-vo-001',
};
const OTHER_VENUE = {
  userId: 'venue-other-002',
  email: 'othervenue@test.com',
  role: UserRole.VENUE,
  displayName: 'Other Venue',
  jti: 'jti-vo-002',
};
const ORGANISER = {
  userId: 'org-001',
  email: 'org@test.com',
  role: UserRole.ORGANISER,
  displayName: 'Organiser',
  jti: 'jti-org-001',
};
const OTHER_ORGANISER = {
  userId: 'org-002',
  email: 'org2@test.com',
  role: UserRole.ORGANISER,
  displayName: 'Other Organiser',
  jti: 'jti-org-002',
};
const CUSTOMER = {
  userId: 'cust-001',
  email: 'cust@test.com',
  role: UserRole.CUSTOMER,
  displayName: 'Customer',
  jti: 'jti-cust-001',
};
const ADMIN = {
  userId: 'admin-001',
  email: 'admin@test.com',
  role: UserRole.ADMIN,
  displayName: 'Admin',
  jti: 'jti-admin-001',
};

describe('VenueBookingsController (integration)', () => {
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

  /** Seed a venue directly via the model (no public activate endpoint exists). */
  const seedVenue = async (ownerId: string, status: string): Promise<string> => {
    const venueId = uuidv4();
    await venueModel.create({
      venueId,
      ownerId,
      name: 'Seed Venue',
      city: 'Mumbai',
      address: '1 Marine Drive',
      status,
      totalCapacity: 1000,
      schemaVersion: '1.0.0',
    });
    return venueId;
  };

  /** Organiser creates a REQUESTED booking against an ACTIVE venue; returns vbId. */
  const seedBooking = async (venueId: string): Promise<string> => {
    asActor(ORGANISER);
    const res = await supertest(app.getHttpServer())
      .post('/venue-bookings')
      .set('Authorization', 'Bearer mock-token')
      .set('Idempotency-Key', uuidv4()) // <-- unique per booking; mirrors a real client
      .send({
        venueId,
        fromDate: '2026-09-01T18:00:00.000Z',
        toDate: '2026-09-01T23:00:00.000Z',
        expectedAttendance: 500,
        eventType: 'Concert',
        venueRevenueSharePercentage: '30.0000',
      });
    expect(res.status).toBe(201);
    return res.body.vbId as string;
  };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: VenueBooking.name, schema: VenueBookingSchema },
          { name: Venue.name, schema: VenueSchema },
          { name: Outbox.name, schema: OutboxSchema },
          { name: UnavailabilityWindow.name, schema: UnavailabilityWindowSchema },
        ]),
      ],
      controllers: [VenueBookingsController],
      providers: [
        VenueBookingsService,
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

  describe('GET /venue-bookings/:vbId — authorization', () => {
    let activeVenueId: string;
    let vbId: string;

    beforeEach(async () => {
      activeVenueId = await seedVenue(VENUE_OWNER.userId, 'ACTIVE');
      vbId = await seedBooking(activeVenueId);
    });

    it('returns 403 to a CUSTOMER (wrong role — blocked before lookup, NFR-SEC-003)', async () => {
      asActor(CUSTOMER);
      const res = await supertest(app.getHttpServer())
        .get(`/venue-bookings/${vbId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(403);
    });

    it('returns 200 to the ORGANISER who created it', async () => {
      asActor(ORGANISER);
      const res = await supertest(app.getHttpServer())
        .get(`/venue-bookings/${vbId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
      expect(res.body.vbId).toBe(vbId);
    });

    it('returns 404 to a different ORGANISER (non-party — existence concealed)', async () => {
      asActor(OTHER_ORGANISER);
      const res = await supertest(app.getHttpServer())
        .get(`/venue-bookings/${vbId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(404);
    });

    it('returns 200 to the VENUE that owns the target venue', async () => {
      asActor(VENUE_OWNER);
      const res = await supertest(app.getHttpServer())
        .get(`/venue-bookings/${vbId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
    });

    it('returns 404 to a VENUE that does not own the target venue', async () => {
      asActor(OTHER_VENUE);
      const res = await supertest(app.getHttpServer())
        .get(`/venue-bookings/${vbId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(404);
    });

    it('returns 200 to ADMIN', async () => {
      asActor(ADMIN);
      const res = await supertest(app.getHttpServer())
        .get(`/venue-bookings/${vbId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /venue-bookings — venue status gate (409 → 404 behaviour change)', () => {
    it('returns 404 (not 409) when the target venue is PENDING_KYC', async () => {
      const pendingVenueId = await seedVenue(VENUE_OWNER.userId, 'PENDING_KYC');
      asActor(ORGANISER);
      const res = await supertest(app.getHttpServer())
        .post('/venue-bookings')
        .set('Authorization', 'Bearer mock-token')
        .set('Idempotency-Key', uuidv4())
        .send({
          venueId: pendingVenueId,
          fromDate: '2026-10-01T18:00:00.000Z',
          toDate: '2026-10-01T23:00:00.000Z',
          expectedAttendance: 100,
          venueRevenueSharePercentage: '25.0000',
        });
      expect(res.status).toBe(404);
    });

    it('returns 201 when the target venue is ACTIVE', async () => {
      const activeVenueId = await seedVenue(VENUE_OWNER.userId, 'ACTIVE');
      asActor(ORGANISER);
      const res = await supertest(app.getHttpServer())
        .post('/venue-bookings')
        .set('Authorization', 'Bearer mock-token')
        .set('Idempotency-Key', uuidv4())
        .send({
          venueId: activeVenueId,
          fromDate: '2026-11-01T18:00:00.000Z',
          toDate: '2026-11-01T23:00:00.000Z',
          expectedAttendance: 100,
          venueRevenueSharePercentage: '25.0000',
        });
      expect(res.status).toBe(201);
    });
  });
});
