import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OutboxDocument = HydratedDocument<Outbox>;

export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

/**
 * Transactional Outbox record (NFR-REL-005).
 *
 * WHY the Outbox pattern exists:
 * Without the Outbox, we face the dual-write problem: a service writes to
 * MongoDB and then publishes to Kafka. If the process crashes between the two,
 * the state is changed but the event is never published. Downstream services
 * never know the transition happened — permanent data loss.
 *
 * The Outbox solves this by making both writes (the state change and the
 * event record) part of the SAME MongoDB transaction. If the transaction
 * commits, the event is guaranteed to eventually reach Kafka. If it aborts,
 * neither write persists. The publisher is a separate process concern.
 *
 * This requires MongoDB replica set mode (transactions need replica set).
 * See docker-compose.yml for --replSet rs0 configuration.
 *
 * Anti-pattern: "I'll just publish to Kafka in the service method after saving."
 * That is the dual-write problem. It works in the happy path and silently
 * loses events on crashes. Do not do it.
 */
@Schema({
  collection: 'outbox',
  timestamps: false, // we manage createdAt manually for ordering guarantees
})
export class Outbox {
  @Prop({ type: String, required: true })
  outboxId!: string;

  /** 'Venue' | 'VenueBooking' — identifies which aggregate produced this event. */
  @Prop({ type: String, required: true, index: true })
  aggregateType!: string;

  /** venueId or vbId — used to order events per aggregate. */
  @Prop({ type: String, required: true, index: true })
  aggregateId!: string;

  /** Kafka message type, e.g. 'VenueCreated', 'VenueBookingAccepted'. */
  @Prop({ type: String, required: true })
  eventType!: string;

  /** Full event payload — schema-compatible with venue_async.yaml. */
  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: String, enum: ['PENDING', 'PUBLISHED', 'FAILED'], default: 'PENDING', index: true })
  status!: OutboxStatus;

  /** Incremented on each failed publish attempt. Max 5 before FAILED. */
  @Prop({ type: Number, default: 0 })
  retryCount!: number;

  /** Set when this record was created. Used for ordering within an aggregate. */
  @Prop({ type: Date, required: true, default: () => new Date() })
  createdAt!: Date;

  /** Set when status transitions to PUBLISHED. */
  @Prop({ type: Date, default: null })
  processedAt!: Date | null;
}

export const OutboxSchema = SchemaFactory.createForClass(Outbox);

// Compound index: the publisher polls { status: PENDING } ordered by createdAt.
// This index covers the entire polling query.
OutboxSchema.index({ status: 1, createdAt: 1 });
