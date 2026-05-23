/**
 * Integration tests for VenuesController.
 *
 * Rules applied (from PHASE3-EVENT-SERVICE-BUILD-LOG.md):
 * RULE-08: Always use NestExpressApplication (Express adapter) — never Fastify.
 * RULE-09: Never import @Global() modules in TestingModule — declare providers explicitly.
 * RULE-11: import * as supertest (CommonJS module without default export).
 * RULE-12: @testcontainers/mongodb (not base testcontainers package).
 *
 * Test strategy:
 * - Start a real MongoDB container with replica set (required for transactions).
 * - Mock JwksService (returns pre-signed token payload without real JWKS fetch).
 * - Mock KafkaService and OutboxService (no real Kafka needed for HTTP tests).
 * - Test: route resolution, auth enforcement, validation, tenant isolation.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import * as supertest from 'supertest';
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

// Pre-built JWT payloads for test actors. In integration tests we mock JwksService
// to return these directly, bypassing real signature verification.
const VENUE_ACTOR = {
  userId: 'venue-user-001',
  email: 'venue@test.com',
  role: UserRole.VENUE,
  displayName: 'Test Venue Owner',
  jti: 'jti-venue-001',
};

const ORGANISER_ACTOR = {
  userId: 'org-user-001',
  email: 'organiser@test.com',
  role: UserRole.ORGANISER,
  displayName: 'Test Organiser',
  jti: 'jti-org-001',
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
  let container: StartedMongoDBContainer;
  let connection: Connection;

  // The mock JwksService maps the token string to a pre-built actor payload.
  // This avoids real RS256 key generation in tests.
  const mockJwksService = {
    validateToken: jest.fn(),
  };

  const mockKafkaService = {
    send: jest.fn().mockResolvedValue(undefined),
  };

  // OutboxService mock: captures outbox calls without needing a real transaction session.
  // The real OutboxService requires a Mongoose ClientSession for atomicity.
  // In tests, we verify the business logic without the transactional Outbox overhead.
  const mockOutboxService = {
    create: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    // Start MongoDB with replica set — required for transactions (Outbox pattern).
    // Single-node rs0 replica set is sufficient for development and testing.
    container = await new MongoDBContainer('mongo:7.0')
      .withReplicaSet('rs0')
      .start();

    const uri = container.getConnectionString();

    const moduleRef = await Test.createTestingModule({
      imports: [
        // RULE-09: declare Mongoose directly in the test module — not via AppModule.
        MongooseModule.forRoot(uri, { directConnection: true }),
        MongooseModule.forFeature([
          { name: Venue.name, schema: VenueSchema },
          { name: Outbox.name, schema: OutboxSchema },
        ]),
      ],
      controllers: [VenuesController],
      providers: [
        VenuesService,
        // RULE-09: declare mocked global providers explicitly.
        { provide: JwksService, useValue: mockJwksService },
        { provide: KafkaService, useValue: mockKafkaService },
        { provide: OutboxService, useValue: mockOutboxService },
        // Guards must be provided explicitly in test context.
        JwtAuthGuard,
        RolesGuard,
      ],
    }).compile();

    // RULE-08: always use NestExpressApplication.
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();

    connection = moduleRef.get<Connection>(getConnectionToken());
  }, 120_000); // generous timeout for container startup

  afterAll(async () => {
    await connection.close();
    await app.close();
    await container.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper: configure the mock to return a specific actor for this request.
  const asActor = (actor: typeof VENUE_ACTOR): void => {
    mockJwksService.validateToken.mockResolvedValueOnce({
      sub: actor.userId,
      email: actor.email,
      role: actor.role,
      displayName: actor.displayName,
      jti: actor.jti,
    });
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
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
        .post('/venues')
        .send(validBody);
      expect(res.status).toBe(401);
    });

    it('returns 403 when actor role is ORGANISER (not VENUE)', async () => {
      asActor(ORGANISER_ACTOR);
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
        .post('/venues')
        .set('Authorization', 'Bearer mock-token')
        .send(validBody);
      expect(res.status).toBe(403);
    });

    it('returns 201 with venue document for VENUE actor', async () => {
      asActor(VENUE_ACTOR);
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
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
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
        .post('/venues')
        .set('Authorization', 'Bearer mock-token')
        .send({ name: 'No capacity venue', city: 'Delhi', address: '1 India Gate' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /venues', () => {
    it('returns 401 without auth', async () => {
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
        .get('/venues');
      expect(res.status).toBe(401);
    });

    it('returns 200 with paginated list for ADMIN', async () => {
      asActor(ADMIN_ACTOR);
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
        .get('/venues')
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('nextCursor');
      expect(Array.isArray(res.body.items)).toBe(true);
    });
  });

  describe('GET /venues/:venueId — tenant isolation', () => {
    let createdVenueId: string;

    beforeEach(async () => {
      // Create a venue owned by VENUE_ACTOR.
      asActor(VENUE_ACTOR);
      mockOutboxService.create.mockResolvedValueOnce(undefined);
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
        .post('/venues')
        .set('Authorization', 'Bearer mock-token')
        .send({ name: 'Isolation Test Venue', city: 'Pune', address: '1 MG Road', totalCapacity: 200 });
      createdVenueId = res.body.venueId;
    });

    it('returns 200 for the owner (VENUE_ACTOR)', async () => {
      asActor(VENUE_ACTOR);
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
      expect(res.body.venueId).toBe(createdVenueId);
    });

    it('returns 404 for a different VENUE actor (tenant isolation — NFR-SEC-004)', async () => {
      // A different VENUE actor tries to read another owner's venue.
      mockJwksService.validateToken.mockResolvedValueOnce({
        sub: 'different-venue-user-999',
        email: 'other@test.com',
        role: UserRole.VENUE,
        displayName: 'Other Venue',
        jti: 'jti-other-999',
      });
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      // 404, not 403 — we never reveal that the venue exists (NFR-SEC-004).
      expect(res.status).toBe(404);
    });

    it('returns 200 for ADMIN (sees all venues)', async () => {
      asActor(ADMIN_ACTOR);
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /health/live', () => {
    it('returns 200 UP without auth (public endpoint)', async () => {
      const res = await (supertest as unknown as (app: unknown) => supertest.SuperTest<supertest.Test>)(app.getHttpServer())
        .get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UP');
    });
  });
});
