/**
 * Integration tests for VenuesController.
 *
 * Rules applied:
 * RULE-08: Always use NestExpressApplication (Express adapter) — never Fastify.
 * RULE-09: Never import @Global() modules in TestingModule — declare providers explicitly.
 * RULE-11 (corrected): supertest uses default import — it has a callable default export.
 * RULE-26: MongoDB integration tests use mongodb-memory-server, not @testcontainers/mongodb.
 * RULE-27: After app.init(), call connection.syncIndexes() before any test that writes
 *   inside a transaction.
 *
 * NFR-SEC-004 read-authz matrix (this is the contract these tests assert):
 *
 *           | ACTIVE venue | PENDING_KYC venue
 *   --------+--------------+------------------
 *   OWNER   |    200       |    200
 *   ADMIN   |    200       |    200
 *   VENUE-B |    404       |    404
 *   ORG     |    200       |    404   <-- the leak that was being fixed
 *   CUST    |    200       |    404   <-- the leak that was being fixed
 *
 * The previous suite only covered OWNER / VENUE-B / ADMIN — exactly the branches
 * the buggy code already had — so it could not catch ORG/CUST falling through to
 * 200 on a non-ACTIVE venue. These tests are written from the contract matrix,
 * not from the implementation's if-branches.
 */
import { HealthController } from '../../src/health/health.controller';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import supertest from 'supertest';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { JwksService } from '../../src/jwks/jwks.service';
import { KafkaService } from '../../src/kafka/kafka.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { Outbox, OutboxSchema } from '../../src/outbox/schemas/outbox.schema';
import { VenuesController } from '../../src/venues/venues.controller';
import { VenuesService } from '../../src/venues/venues.service';
import { Venue, VenueSchema } from '../../src/venues/schemas/venue.schema';
import { UserRole } from '../../src/common/types/jwt-payload.types';

const VENUE_ACTOR = {
  userId: 'venue-user-001',
  email: 'venue@test.com',
  role: UserRole.VENUE,
  displayName: 'Test Venue Owner',
  jti: 'jti-venue-001',
};

const OTHER_VENUE_ACTOR = {
  userId: 'different-venue-user-999',
  email: 'other@test.com',
  role: UserRole.VENUE,
  displayName: 'Other Venue',
  jti: 'jti-other-999',
};

const ORGANISER_ACTOR = {
  userId: 'org-user-001',
  email: 'organiser@test.com',
  role: UserRole.ORGANISER,
  displayName: 'Test Organiser',
  jti: 'jti-org-001',
};

const CUSTOMER_ACTOR = {
  userId: 'cust-user-001',
  email: 'customer@test.com',
  role: UserRole.CUSTOMER,
  displayName: 'Test Customer',
  jti: 'jti-cust-001',
};

const ADMIN_ACTOR = {
  userId: 'admin-user-001',
  email: 'admin@test.com',
  role: UserRole.ADMIN,
  displayName: 'Test Admin',
  jti: 'jti-admin-001',
};

describe('VenuesController (integration)', () => {
  let app: INestApplication;
  let replSet: MongoMemoryReplSet;
  let connection: Connection;

  const mockJwksService = { validateToken: jest.fn() };
  const mockKafkaService = { send: jest.fn().mockResolvedValue(undefined) };
  const mockOutboxService = { create: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Venue.name, schema: VenueSchema },
          { name: Outbox.name, schema: OutboxSchema },
        ]),
      ],
      controllers: [VenuesController, HealthController],
      providers: [
        VenuesService,
        { provide: JwksService, useValue: mockJwksService },
        { provide: KafkaService, useValue: mockKafkaService },
        { provide: OutboxService, useValue: mockOutboxService },
        JwtAuthGuard,
        RolesGuard,
      ],
    }).compile();

    connection = moduleRef.get<Connection>(getConnectionToken());

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

  const asActor = (actor: typeof VENUE_ACTOR): void => {
    mockJwksService.validateToken.mockResolvedValueOnce({
      sub: actor.userId,
      email: actor.email,
      role: actor.role,
      displayName: actor.displayName,
      jti: actor.jti,
    });
  };

  /**
   * Flip a venue to ACTIVE directly via the collection. There is NO public
   * "activate venue" endpoint (activation is an Admin/KYC concern out of scope
   * here), so tests MUST NOT call one that does not exist. A direct DB write is
   * the correct way to put a venue into the state under test.
   */
  const setVenueStatus = async (venueId: string, status: string): Promise<void> => {
    await connection.collection('venues').updateOne({ venueId }, { $set: { status } });
  };

  /** Create a PENDING_KYC venue owned by VENUE_ACTOR; returns its venueId. */
  const createVenue = async (): Promise<string> => {
    asActor(VENUE_ACTOR);
    const res = await supertest(app.getHttpServer())
      .post('/venues')
      .set('Authorization', 'Bearer mock-token')
      .send({ name: 'Matrix Venue', city: 'Pune', address: '1 MG Road', totalCapacity: 200 });
    return res.body.venueId as string;
  };

  describe('POST /venues', () => {
    const validBody = {
      name: 'The Grand Arena',
      city: 'Mumbai',
      address: '1 Marine Drive, Mumbai 400020',
      totalCapacity: 5000,
      facilities: ['parking', 'accessible_toilets'],
    };

    it('returns 401 when no Authorization header is provided', async () => {
      const res = await supertest(app.getHttpServer()).post('/venues').send(validBody);
      expect(res.status).toBe(401);
    });

    it('returns 403 when actor role is ORGANISER (not VENUE)', async () => {
      asActor(ORGANISER_ACTOR);
      const res = await supertest(app.getHttpServer())
        .post('/venues')
        .set('Authorization', 'Bearer mock-token')
        .send(validBody);
      expect(res.status).toBe(403);
    });

    it('returns 201 with venue document for VENUE actor', async () => {
      asActor(VENUE_ACTOR);
      const res = await supertest(app.getHttpServer())
        .post('/venues')
        .set('Authorization', 'Bearer mock-token')
        .send(validBody);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        venueId: expect.any(String),
        ownerId: VENUE_ACTOR.userId,
        name: validBody.name,
        city: validBody.city,
        status: 'PENDING_KYC',
      });
    });

    it('returns 400 when required field is missing', async () => {
      asActor(VENUE_ACTOR);
      const res = await supertest(app.getHttpServer())
        .post('/venues')
        .set('Authorization', 'Bearer mock-token')
        .send({ name: 'No capacity venue', city: 'Delhi', address: '1 India Gate' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /venues', () => {
    it('returns 401 without auth', async () => {
      const res = await supertest(app.getHttpServer()).get('/venues');
      expect(res.status).toBe(401);
    });

    it('returns 200 with paginated list for ADMIN', async () => {
      asActor(ADMIN_ACTOR);
      const res = await supertest(app.getHttpServer())
        .get('/venues')
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('nextCursor');
      expect(Array.isArray(res.body.items)).toBe(true);
    });
  });

  describe('GET /venues/:venueId — owner / cross-venue / admin (regression)', () => {
    let createdVenueId: string;

    beforeEach(async () => {
      createdVenueId = await createVenue();
    });

    it('returns 200 for the owner (VENUE_ACTOR), any status', async () => {
      asActor(VENUE_ACTOR);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
      expect(res.body.venueId).toBe(createdVenueId);
    });

    it('returns 404 for a different VENUE actor (NFR-SEC-004)', async () => {
      asActor(OTHER_VENUE_ACTOR);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(404);
    });

    it('returns 200 for ADMIN (sees all venues)', async () => {
      asActor(ADMIN_ACTOR);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /venues/:venueId — public-role visibility (NFR-SEC-004 — the fix)', () => {
    let createdVenueId: string;

    beforeEach(async () => {
      createdVenueId = await createVenue(); // PENDING_KYC by default
    });

    it('returns 404 to an ORGANISER for a PENDING_KYC venue (was 200 — the leak)', async () => {
      asActor(ORGANISER_ACTOR);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(404);
    });

    it('returns 404 to a CUSTOMER for a PENDING_KYC venue (was 200 — the leak)', async () => {
      asActor(CUSTOMER_ACTOR);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(404);
    });

    it('returns 200 to an ORGANISER for an ACTIVE venue (public discovery preserved)', async () => {
      await setVenueStatus(createdVenueId, 'ACTIVE');
      asActor(ORGANISER_ACTOR);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
      expect(res.body.venueId).toBe(createdVenueId);
    });

    it('returns 200 to a CUSTOMER for an ACTIVE venue (public discovery preserved)', async () => {
      await setVenueStatus(createdVenueId, 'ACTIVE');
      asActor(CUSTOMER_ACTOR);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
    });

    it('returns 404 to a CUSTOMER for a SUSPENDED venue (non-ACTIVE is not public)', async () => {
      await setVenueStatus(createdVenueId, 'SUSPENDED');
      asActor(CUSTOMER_ACTOR);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(404);
    });
  });

  /**
   * Parity guard: findAll (list filter) and findOne (canView) must agree.
   * If a venue is invisible to an actor on the list, fetching it by id must 404.
   * This catches the next person who updates one path and forgets the other.
   */
  describe('findAll / findOne visibility parity (NFR-SEC-004)', () => {
    it('a PENDING_KYC venue absent from a CUSTOMER list also 404s by id', async () => {
      const venueId = await createVenue(); // PENDING_KYC

      asActor(CUSTOMER_ACTOR);
      const listRes = await supertest(app.getHttpServer())
        .get('/venues')
        .set('Authorization', 'Bearer mock-token');
      expect(listRes.status).toBe(200);
      const ids = (listRes.body.items as Array<{ venueId: string }>).map((v) => v.venueId);
      expect(ids).not.toContain(venueId); // absent from list

      asActor(CUSTOMER_ACTOR);
      const byIdRes = await supertest(app.getHttpServer())
        .get(`/venues/${venueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(byIdRes.status).toBe(404); // ...therefore 404 by id
    });
  });

  describe('GET /health/live', () => {
    it('returns 200 UP without auth (public endpoint)', async () => {
      const res = await supertest(app.getHttpServer()).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UP');
    });
  });
});
