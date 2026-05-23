import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UnavailabilityWindowDocument = HydratedDocument<UnavailabilityWindow>;

@Schema({
  collection: 'unavailability_windows',
  toJSON: { virtuals: false },
  toObject: { virtuals: false },
})
export class UnavailabilityWindow {
  @Prop({ type: String, required: true, unique: true })
  windowId!: string;

  @Prop({ type: String, required: true, index: true })
  venueId!: string;

  /** Date only (time zeroed). Stored as Date for range query support. */
  @Prop({ type: Date, required: true })
  fromDate!: Date;

  @Prop({ type: Date, required: true })
  toDate!: Date;

  @Prop({ type: String, required: true, maxlength: 500 })
  reason!: string;

  @Prop({ type: String, default: null, sparse: true, unique: true })
  idempotencyKey!: string | null;

  @Prop({ type: Date, default: () => new Date() })
  createdAt!: Date;
}

export const UnavailabilityWindowSchema = SchemaFactory.createForClass(UnavailabilityWindow);

// Compound index for date-range overlap query on booking request validation.
UnavailabilityWindowSchema.index({ venueId: 1, fromDate: 1, toDate: 1 });
