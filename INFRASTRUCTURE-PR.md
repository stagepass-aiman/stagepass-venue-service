# ─────────────────────────────────────────────────────────────────────────────
# INFRASTRUCTURE PR 3 — Venue Service Integration
# Target repo: stagepass-infrastructure
# ─────────────────────────────────────────────────────────────────────────────
#
# This file documents every change needed in stagepass-infrastructure to
# integrate the Venue Service into the full stack. Apply each section to
# the corresponding file in stagepass-infrastructure.
#
# ⚠️  IMPORTANT: MongoDB must be updated to run as a single-node replica set.
# The Venue Service uses MongoDB transactions (Outbox pattern, NFR-REL-005).
# This change is backward-compatible for the Event Service.
# ─────────────────────────────────────────────────────────────────────────────


# ═══════════════════════════════════════════════════════════════════════════════
# FILE: docker/compose/docker-compose.yml
# ═══════════════════════════════════════════════════════════════════════════════
#
# 1. UPDATE the existing `mongodb` service definition to add replica set support:
#
#   mongodb:
#     image: mongo:7.0
#     command: ["--replSet", "rs0", "--bind_ip_all"]   ← ADD THIS LINE
#     ...
#
# 2. ADD a new one-shot init service for replica set initialisation:

mongo-rs-init:
  image: mongo:7.0
  profiles: [infra]
  depends_on:
    mongodb:
      condition: service_healthy
  restart: on-failure
  entrypoint: >
    mongosh --host mongodb:27017 --quiet --eval
    "try { rs.status(); print('already initialised'); }
     catch(e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] }); print('initialised'); }"
  networks:
    - stagepass-net

# 3. ADD the venue-service definition:

venue-service:
  profiles: [infra]
  build:
    context: ../../../stagepass-venue-service   # path to the service repo
    dockerfile: Dockerfile
  image: ghcr.io/stagepass-aiman/stagepass-venue-service:latest
  container_name: venue-service
  ports:
    - "8083:8083"
  environment:
    PORT: 8083
    NODE_ENV: development
    # RULE-16: internal Kafka listener — never localhost inside Docker
    KAFKA_BROKERS: kafka:9092
    # directConnection=true required for single-node replica set
    MONGODB_URI: mongodb://mongodb:27017/venue?replicaSet=rs0&directConnection=true
    AUTH_JWKS_URI: http://auth-service:8081/auth/jwks
    # RULE-16: OTel collector is reachable by container name, not localhost
    OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
    OTEL_SERVICE_NAME: venue-service
  depends_on:
    mongodb:
      condition: service_healthy
    mongo-rs-init:
      condition: service_completed_successfully
    kafka:
      condition: service_healthy
    kafka-init:
      condition: service_completed_successfully
    auth-service:
      condition: service_healthy
  # No Docker HEALTHCHECK here — we verify from outside (see smoke-test.sh).
  # node:20-alpine has wget; healthcheck is fine. Only distroless has no shell.
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:8083/health/ready"]
    interval: 15s
    timeout: 5s
    retries: 5
    start_period: 30s
  networks:
    - stagepass-net
  mem_limit: 512m     # T2 service memory limit


# ═══════════════════════════════════════════════════════════════════════════════
# FILE: docker/compose/init/kafka/kafka-init.sh
# ═══════════════════════════════════════════════════════════════════════════════
# ADD these lines to the kafka-init.sh topic creation block:

# venue.events — published by Venue Service (Outbox pattern)
# 6 partitions: venue volume is lower than booking/event domains
# Partition key: venueId — all events for one venue land on the same partition
kafka-topics.sh --bootstrap-server kafka:9092 \
  --create --if-not-exists \
  --topic venue.events \
  --partitions 6 \
  --replication-factor 1 \
  --config retention.ms=2592000000  # 30 days

# venue.events.dlq — NFR-REL-007: every topic must have a DLQ
# Alert fires when DLQ depth > 0 for > 5 minutes
kafka-topics.sh --bootstrap-server kafka:9092 \
  --create --if-not-exists \
  --topic venue.events.dlq \
  --partitions 6 \
  --replication-factor 1 \
  --config retention.ms=1209600000  # 14 days


# ═══════════════════════════════════════════════════════════════════════════════
# FILE: observability/prometheus/prometheus.yml
# ═══════════════════════════════════════════════════════════════════════════════
# ADD this scrape config to the scrape_configs list:
#
# RULE-17: cross-check port 8083 against venue.yaml (authoritative).
# Pre-populated placeholder ports from Phase 2 may be wrong.

  - job_name: venue-service
    static_configs:
      - targets: ['venue-service:8083']
    metrics_path: /metrics
    scrape_interval: 15s


# ═══════════════════════════════════════════════════════════════════════════════
# FILE: scripts/smoke-test.sh
# ═══════════════════════════════════════════════════════════════════════════════
# ADD these checks to the smoke test after the Event Service checks:

echo "Checking Venue Service..."
VENUE_LIVE=$(curl -sf http://localhost:8083/health/live | jq -r '.status')
if [ "$VENUE_LIVE" = "UP" ]; then
  echo "  [PASS] venue-service /health/live"
else
  echo "  [FAIL] venue-service /health/live (got: $VENUE_LIVE)"
  FAILURES=$((FAILURES + 1))
fi

VENUE_READY=$(curl -sf http://localhost:8083/health/ready | jq -r '.status')
if [ "$VENUE_READY" = "UP" ]; then
  echo "  [PASS] venue-service /health/ready"
else
  echo "  [FAIL] venue-service /health/ready (got: $VENUE_READY)"
  FAILURES=$((FAILURES + 1))
fi
