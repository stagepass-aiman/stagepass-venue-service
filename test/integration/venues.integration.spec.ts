/**
 * Integration tests for VenuesController.
 *
 * Rules applied:
 * RULE-08: Always use NestExpressApplication (Express adapter) — never Fastify.
 * RULE-09: Never import @Global() modules in TestingModule — declare providers explicitly.
 * RULE-11 (corrected): supertest uses default import — it has a callable default export.
 *   import * as supertest is wrong for callable modules; see build log RULE-11 correction.
 * RULE-26: MongoDB integration tests use mongodb-memory-server, not @testcontainers/mongodb.
 *   MongoMemoryReplSet avoids Windows hostname resolution issues and supports transactions.
 * RULE-27: After app.init(), call connection.syncIndexes() before any test that writes
 *   inside a transaction. MongoDB cannot implicitly create collections in a transaction.
 *
 * Test strategy:
 * - MongoMemoryReplSet: in-process MongoDB with replica set (required for transactions).
 * - Mock JwksService: returns pre-built actor payload without real RS256 verification.
 * - Mock KafkaService and OutboxService: no real Kafka needed for HTTP surface tests.
 * - Tests cover: route resolution, auth enforcement, validation, tenant isolation.
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
  let replSet: MongoMemoryReplSet;
  let connection: Connection;

  const mockJwksService = {
    validateToken: jest.fn(),
  };

  const mockKafkaService = {
    send: jest.fn().mockResolvedValue(undefined),
  };

  // OutboxService is mocked — the real implementation requires a ClientSession
  // passed from the caller's MongoDB transaction. Tests verify HTTP behaviour,
  // not transactional atomicity. Atomicity is verified against the real replica
  // set when the service runs under docker compose.
  const mockOutboxService = {
    create: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    // MongoMemoryReplSet: in-process MongoDB with replica set.
    // Replica set is required because VenuesService.create() uses
    // startSession() + startTransaction() for the Outbox pattern.
    // Standalone MongoDB rejects transactions entirely.
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
        // RULE-09: @Global() providers (JwksService, KafkaService) do not
        // auto-populate in TestingModule — declare them explicitly as mocks.
        { provide: JwksService, useValue: mockJwksService },
        { provide: KafkaService, useValue: mockKafkaService },
        { provide: OutboxService, useValue: mockOutboxService },
        JwtAuthGuard,
        RolesGuard,
      ],
    }).compile();

    // RULE-27: assign connection BEFORE app.init() and syncIndexes().
    // connection is undefined until moduleRef.get() is called — any use
    // before this line throws "Cannot read properties of undefined".
    connection = moduleRef.get<Connection>(getConnectionToken());

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();

    // RULE-27: force all collections and indexes to exist before any test runs.
    // MongoDB transactions cannot implicitly create collections — if 'venues'
    // does not exist when the first transaction starts, the insert fails with
    // a catalog changes error. syncIndexes() creates all registered collections.
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

  describe('POST /venues', () => {
    const validBody = {
      name: 'The Grand Arena',
      city: 'Mumbai',
      address: '1 Marine Drive, Mumbai 400020',
      totalCapacity: 5000,
      facilities: ['parking', 'accessible_toilets'],
    };

    it('returns 401 when no Authorization header is provided', async () => {
      const res = await supertest(app.getHttpServer())
        .post('/venues')
        .send(validBody);
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

  describe('GET /venues/:venueId — tenant isolation', () => {
    let createdVenueId: string;

    beforeEach(async () => {
      asActor(VENUE_ACTOR);
      mockOutboxService.create.mockResolvedValueOnce(undefined);
      const res = await supertest(app.getHttpServer())
        .post('/venues')
        .set('Authorization', 'Bearer mock-token')
        .send({ name: 'Isolation Test Venue', city: 'Pune', address: '1 MG Road', totalCapacity: 200 });
      createdVenueId = res.body.venueId;
    });

    it('returns 200 for the owner (VENUE_ACTOR)', async () => {
      asActor(VENUE_ACTOR);
      const res = await supertest(app.getHttpServer())
        .get(`/venues/${createdVenueId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(res.status).toBe(200);
      expect(res.body.venueId).toBe(createdVenueId);
    });

    it('returns 404 for a different VENUE actor (tenant isolation — NFR-SEC-004)', async () => {
      // 404 not 403: we never confirm the resource exists to an unauthorised caller.
      // venue.yaml documents 403 here — that is a spec error. NFR-SEC-004 is authoritative.
      mockJwksService.validateToken.mockResolvedValueOnce({
        sub: 'different-venue-user-999',
        email: 'other@test.com',
        role: UserRole.VENUE,
        displayName: 'Other Venue',
        jti: 'jti-other-999',
      });
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

  describe('GET /health/live', () => {
    it('returns 200 UP without auth (public endpoint)', async () => {
      const res = await supertest(app.getHttpServer()).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UP');
    });
  });
});