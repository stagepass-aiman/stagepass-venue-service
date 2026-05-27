import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { KafkaService } from '../kafka/kafka.service';
import { Outbox, OutboxDocument } from './schemas/outbox.schema';

const MAX_RETRIES = 5;
const KAFKA_TOPIC = 'venue.events';
const KAFKA_DLQ_TOPIC = 'venue.events.dlq';

/**
 * Background publisher that polls the outbox collection every 5 seconds
 * and publishes PENDING records to Kafka.
 *
 * Why polling (not Change Streams):
 * Polling is simpler to reason about and sufficient for Phase 4. The worst-case
 * event latency is 5 seconds — acceptable for non-time-critical venue events.
 * Change Streams would give sub-second latency but require a persistent
 * resume token to survive restarts, adding operational complexity.
 *
 * PHASE 7 TODO: If event latency SLO is breached in load tests, switch to
 * MongoDB Change Streams on the outbox collection with a persisted resume token.
 *
 * Failure handling:
 * - On publish failure: increment retryCount.
 * - After MAX_RETRIES failures: mark FAILED, move payload to DLQ topic.
 * - Prometheus alert fires when DLQ depth > 0 for > 5 min (NFR-REL-007).
 *
 * The publisher is non-atomic by design: if the process crashes after
 * publishing to Kafka but before marking the outbox record as PUBLISHED,
 * the record will be published again on the next poll. Kafka consumers
 * must be idempotent (NFR-REL-002) to handle this at-least-once delivery.
 */
@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    @InjectModel(Outbox.name) private readonly outboxModel: Model<OutboxDocument>,
    private readonly kafkaService: KafkaService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async publishPending(): Promise<void> {
    const pending = await this.outboxModel
      .find({ status: 'PENDING', retryCount: { $lt: MAX_RETRIES } })
      .sort({ createdAt: 1 })
      .limit(100) // process at most 100 per poll cycle to bound latency
      .exec();

    for (const record of pending) {
      await this.publish(record);
    }
  }

  private async publish(record: OutboxDocument): Promise<void> {
    try {
      await this.kafkaService.send(KAFKA_TOPIC, {
        key: record.aggregateId,
        value: JSON.stringify({
          eventType: record.eventType,
          ...record.payload,
        }),
        headers: {
          'x-event-type': record.eventType,
          'x-aggregate-type': record.aggregateType,
          'x-aggregate-id': record.aggregateId,
          'x-outbox-id': record.outboxId,
        },
      });

      await this.outboxModel.updateOne(
        { _id: record._id },
        { $set: { status: 'PUBLISHED', processedAt: new Date() } },
      );
    } catch (err) {
      const newRetryCount = record.retryCount + 1;
      const willFail = newRetryCount >= MAX_RETRIES;

      this.logger.error(
        `Outbox publish failed: outboxId=${record.outboxId} eventType=${record.eventType} ` +
          `retryCount=${newRetryCount}/${MAX_RETRIES}`,
      );

      if (willFail) {
        // Move to DLQ before marking as failed so the event is not lost.
        try {
          await this.kafkaService.send(KAFKA_DLQ_TOPIC, {
            key: record.aggregateId,
            value: JSON.stringify({
              eventType: record.eventType,
              failureReason: err instanceof Error ? err.message : String(err),
              originalPayload: record.payload,
            }),
          });
        } catch (dlqErr) {
          this.logger.error(`DLQ publish also failed: outboxId=${record.outboxId}`, dlqErr);
        }
      }

      await this.outboxModel.updateOne(
        { _id: record._id },
        {
          $set: {
            retryCount: newRetryCount,
            status: willFail ? 'FAILED' : 'PENDING',
          },
        },
      );
    }
  }
}
