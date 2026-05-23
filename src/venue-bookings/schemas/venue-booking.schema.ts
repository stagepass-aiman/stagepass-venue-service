import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export type VenueBookingDocument = HydratedDocument<VenueBooking>;

export type VenueBookingStatus = 'REQUESTED' | 'ACCEPTED' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED';

@Schema({
  collection: 'venue_bookings',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  // getters: true is REQUIRED for the Decimal128 → string conversion to fire.
  // Without this, venueRevenueSharePercentage serialises as { $numberDecimal: "30.0000" }
  // which violates the venue.yaml wire format and breaks every downstream consumer.
  toJSON: { getters: true, virtuals: false },
  toObject: { getters: true, virtuals: false },
})
export class VenueBooking {
  @Prop({ type: String, required: true, unique: true })
  vbId!: string;

  @Prop({ type: String, required: true, index: true })
  venueId!: string;

  /** userId of the ORGANISER who submitted this request. Immutable. */
  @Prop({ type: String, required: true, index: true })
  organiserId!: string;

  @Prop({ type: Date, required: true })
  fromDate!: Date;

  @Prop({ type: Date, required: true })
  toDate!: Date;

  @Prop({ type: Number, required: true, min: 1 })
  expectedAttendance!: number;

  @Prop({ type: String, maxlength: 100 })
  eventType?: string;

  @Prop({ type: String, maxlength: 2000 })
  message?: string;

  @Prop({
    type: String,
    enum: ['REQUESTED', 'ACCEPTED', 'CONFIRMED', 'REJECTED', 'CANCELLED'],
    default: 'REQUESTED',
    index: true,
  })
  status!: VenueBookingStatus;

  /**
   * The negotiated Venue revenue share percentage.
   *
   * Stored as BSON Decimal128 for exact decimal arithmetic (ADR-004).
   * The getter converts Decimal128 → string on read so the API wire format
   * is "30.0000" as specified in venue.yaml — not { $numberDecimal: "30.0000" }.
   *
   * IMMUTABILITY RULE: once status transitions to ACCEPTED, this field
   * must never be modified. The service layer enforces this. If this value
   * changed after acceptance, all RevenueSplit records computed by the
   * Disbursement Service would be wrong — corrupting the financial ledger.
   * (ADR-004, ADR-008, NFR-REL-012)
   */
  @Prop({
    type: mongoose.Schema.Types.Decimal128,
    required: true,
    get: (v: mongoose.Types.Decimal128): string | undefined => v?.toString(),
  })
  venueRevenueSharePercentage!: string; // type is string because the getter converts it

  @Prop({ type: String, default: null })
  rejectionReason!: string | null;

  /**
   * Set when the Organiser creates an Event linked to this booking.
   * The Event Service publishes a Kafka event when this happens;
   * the Venue Service consumer updates this field.
   *
   * PHASE 4 TODO: implement Kafka consumer for EventCreated → update eventId + status CONFIRMED.
   */
  @Prop({ type: String, default: null, sparse: true, index: true })
  eventId!: string | null;

  /** For idempotency deduplication. Sparse: only indexed when present. */
  @Prop({ type: String, default: null, sparse: true, unique: true })
  idempotencyKey!: string | null;

  @Prop({ type: String, default: '1.0.0' })
  schemaVersion!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const VenueBookingSchema = SchemaFactory.createForClass(VenueBooking);

VenueBookingSchema.index({ venueId: 1, status: 1 });
VenueBookingSchema.index({ organiserId: 1, status: 1 });
// Compound date index for the availability overlap check on booking creation.
VenueBookingSchema.index({ venueId: 1, fromDate: 1, toDate: 1 });
