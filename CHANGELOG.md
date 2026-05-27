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
