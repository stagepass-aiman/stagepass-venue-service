# Changelog

All notable changes to `stagepass-venue-service` follow [Semantic Versioning](https://semver.org/).

---

## [0.1.0] — 2026-05-22

### Added

- Full NestJS 10 scaffold with MongoDB (Mongoose) and KafkaJS
- `Venue` CRUD: `POST /venues`, `GET /venues`, `GET /venues/:venueId`, `PUT /venues/:venueId`
- `SeatingLayout` management: `POST /venues/:venueId/layouts`, `GET /venues/:venueId/layouts`, `GET /venues/:venueId/layouts/:layoutId`
- `VenueBooking` lifecycle: `POST /venue-bookings`, `GET /venue-bookings`, `GET /venue-bookings/:vbId`, `POST /venue-bookings/:vbId/accept`, `POST /venue-bookings/:vbId/reject`
- `UnavailabilityWindow`: `POST /venues/:venueId/unavailability`
- Revenue stub: `GET /venues/:venueId/revenue` (returns empty list — Phase 4 TODO)
- Transactional Outbox pattern for all state-change Kafka events (NFR-REL-005)
- RS256 JWT local validation via JWKS cache (ADR-003)
- RBAC at service layer (NFR-SEC-003)
- Tenant isolation returning 404 on cross-tenant access (NFR-SEC-004)
- `Decimal128` → string serialisation for `venueRevenueSharePercentage` (ADR-004)
- Availability overlap check on VenueBooking creation
- Revenue share immutability enforcement after ACCEPTED transition (ADR-004, ADR-008)
- Health endpoints: `/health/live`, `/health/ready`
- Prometheus metrics: `/metrics`
- OpenTelemetry tracing with OTLP exporter
- Structured JSON logging with correlation IDs (NFR-OBS-001)
- Idempotency-Key support on all mutating endpoints (NFR-REL-001)
- Multi-stage Dockerfile with non-root user
- GitHub Actions CI pipeline with gitleaks, lint, test, integration-test, SonarQube, Trivy
- Integration tests with Testcontainers (MongoDB replica set)

## [0.1.1] - 2026-06-13

### Security

- Enforce object-level authorization on read-by-id endpoints (NFR-SEC-004, BOLA).
  `GET /venues/:id` no longer returns 200 to ORGANISER/CUSTOMER for non-ACTIVE
  venues; non-owner public roles receive 404. `GET /venue-bookings/:vbId` returns
  403 to CUSTOMER (wrong role) and 404 to a non-party Organiser/Venue. Seating-
  layout reads inherit venue visibility via delegation.

### Changed

- Behaviour: `POST /venue-bookings` against a non-ACTIVE venue now returns 404
  (was 409), to avoid confirming venue existence to a caller who cannot see it.

### Tests

- Add integration suites for venue-bookings and seating-layouts controllers
  (role × status matrices). Three tested controllers now (was one).

### Fixed (tooling)

- `npm run test` no longer matches `*.integration.spec.ts`.
