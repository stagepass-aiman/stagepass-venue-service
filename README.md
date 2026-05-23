# stagepass-venue-service

**Tier:** T2 — Important (99.5% SLO)
**Framework:** NestJS 10 · MongoDB · KafkaJS
**Port:** 8083
**Phase:** 4 — Core Services

Manages Venue profiles, Seating Layouts, Venue Booking negotiations, and Unavailability windows. Publishes domain events to the `venue.events` Kafka topic via the Transactional Outbox pattern.

---

## What This Service Does

- **VENUE actor**: register venues, manage seating layouts, block unavailability dates, accept or reject booking requests
- **ORGANISER actor**: discover active venues, submit booking requests for specific dates
- **ADMIN actor**: view and manage all venues including suspension (triggers the Level 1 cascade in the Venue Suspension saga)
- **All authenticated actors**: browse active venues and their layouts

The `VenueBookingAccepted` event published from this service is the upstream trigger for Event creation. The `VenueSuspended` event triggers the most complex compensation cascade in the platform (ADR-008 §3.7).

---

## How to Run Locally (< 30 minutes from clone)

**Prerequisites:** Docker Desktop, Node.js 20, npm

```bash
# 1. Clone and install
git clone https://github.com/stagepass-aiman/stagepass-venue-service.git
cd stagepass-venue-service
npm install                    # generates package-lock.json (RULE-06)

# 2. Configure env
cp .env.example .env
# Edit .env — update AUTH_JWKS_URI to point to your Auth Service

# 3. Start dependencies and the service
docker compose up --build -d

# 4. Verify health
curl http://localhost:8083/health/live
# → {"status":"UP","checks":{"process":"UP"}}

curl http://localhost:8083/health/ready
# → {"status":"UP","checks":{"mongodb":"UP"}}

# 5. View logs
docker compose logs -f venue-service
```

---

## Dependencies

| Direction | Service | Protocol | Purpose |
|-----------|---------|----------|---------|
| Calls | Auth Service | JWKS HTTP | Fetch RS256 public keys for JWT validation at startup |
| Publishes to | Kafka `venue.events` | Kafka | VenueCreated, VenueUpdated, VenueSuspended, VenueBookingAccepted, VenueBookingRejected |
| Called by | API Gateway | REST | All external traffic routed via gateway |
| Called by | Seat Inventory Service | REST | `GET /venues/{venueId}/layouts/{layoutId}` at event creation time to bootstrap seat state |

---

## Environment Variables

Values come from HashiCorp Vault in staging/production. See `.env.example` for names.

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default: 8083) |
| `MONGODB_URI` | MongoDB connection string (must include replica set params for transactions) |
| `KAFKA_BROKERS` | Comma-separated broker list (`kafka:9092` inside Docker) |
| `AUTH_JWKS_URI` | Auth Service JWKS endpoint for JWT public key distribution |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector endpoint |
| `OTEL_SERVICE_NAME` | Service name in traces (default: `venue-service`) |

---

## Health Check Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health/live` | None | Liveness — is the process alive? |
| `GET /health/ready` | None | Readiness — is MongoDB connected? |
| `GET /metrics` | None | Prometheus metrics (RED + default Node.js metrics) |

---

## Key Design Decisions

- **MongoDB replica set required**: The Transactional Outbox pattern (NFR-REL-005) uses multi-document transactions. MongoDB transactions require a replica set. The standalone `docker-compose.yml` starts MongoDB in single-node `rs0` mode.
- **Decimal128 for revenue share**: `venueRevenueSharePercentage` is stored as MongoDB `Decimal128` with a Mongoose `get` transform that serialises it to a string on read. See `src/venue-bookings/schemas/venue-booking.schema.ts`.
- **Tenant isolation returns 404**: `NFR-SEC-004` requires 404 (not 403) for cross-tenant access to avoid leaking resource existence. Note: `venue.yaml` incorrectly documents 403 — this is a spec error; the implementation is correct.
- **Revenue endpoint is a stub**: `GET /venues/{venueId}/revenue` returns an empty list. Real data comes from the Disbursement Service ledger (Phase 4 TODO).

---

## OpenAPI Specification

`stagepass-docs/docs/api/venue.yaml`

---

## Running Tests

```bash
# Unit tests
npm test

# Integration tests (requires Docker — starts MongoDB via Testcontainers)
npm run test:integration

# All with coverage
npm run test:ci
```

---

## Links

- [OpenAPI Spec](https://github.com/stagepass-aiman/stagepass-docs/blob/main/docs/api/venue.yaml)
- [ER Diagram](https://github.com/stagepass-aiman/stagepass-docs/blob/main/docs/er-diagrams/venue.md)
- [ADR-002](https://github.com/stagepass-aiman/stagepass-docs/blob/main/docs/adr/ADR-002-tech-stack-per-service.md) — NestJS + MongoDB decision
- [AsyncAPI Contract](https://github.com/stagepass-aiman/stagepass-docs/blob/main/docs/async-api/venue.yaml)
