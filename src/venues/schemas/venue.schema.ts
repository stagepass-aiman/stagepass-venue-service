import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type VenueDocument = HydratedDocument<Venue>;

export type VenueStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_KYC';

@Schema({
  collection: 'venues',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  // getters: true ensures @Prop({ get }) transformations fire during toJSON().
  // Without this, getters are registered but never called during serialisation.
  toJSON: { getters: true, virtuals: false },
  toObject: { getters: true, virtuals: false },
})
export class Venue {
  /** UUID. Duplicates _id for API clarity. Immutable after creation. */
  @Prop({ type: String, required: true, unique: true })
  venueId!: string;

  /** userId of the VENUE-role account that owns this venue. Immutable. */
  @Prop({ type: String, required: true, index: true })
  ownerId!: string;

  @Prop({ type: String, required: true, maxlength: 200 })
  name!: string;

  @Prop({ type: String, required: true, maxlength: 100, index: true })
  city!: string;

  @Prop({ type: String, required: true, maxlength: 500 })
  address!: string;

  @Prop({ type: Number })
  lat?: number;

  @Prop({ type: Number })
  lng?: number;

  @Prop({
    type: String,
    enum: ['ACTIVE', 'SUSPENDED', 'PENDING_KYC'],
    default: 'PENDING_KYC',
    index: true,
  })
  status!: VenueStatus;

  @Prop({ type: Number, required: true, min: 1 })
  totalCapacity!: number;

  @Prop({ type: [String], default: [] })
  facilities!: string[];

  @Prop({ type: [String], default: [] })
  photoUrls!: string[];

  /** FK → seating_layouts.layoutId. Null until the first layout is created. */
  @Prop({ type: String, default: null })
  latestLayoutId!: string | null;

  @Prop({ type: String, default: '1.0.0' })
  schemaVersion!: string;

  // Injected by { timestamps: true }
  createdAt!: Date;
  updatedAt!: Date;
}

export const VenueSchema = SchemaFactory.createForClass(Venue);

// Compound indexes matching the ER diagram specification.
VenueSchema.index({ ownerId: 1, status: 1 });
VenueSchema.index({ city: 1, status: 1 });
