import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SeatingLayoutDocument = HydratedDocument<SeatingLayout>;

export type SeatType = 'STANDARD' | 'PREMIUM' | 'ACCESSIBLE';

/**
 * Seat — fully embedded within the layout document.
 *
 * Design decision (Option A — see venue.md ER diagram §8):
 * Sections, rows, and seats are embedded in the layout document.
 * The Venue Service never queries individual seats — layouts are always
 * read whole. The Seat Inventory Service reads the full layout once at
 * event creation time to bootstrap its per-seat state table.
 *
 * seatId format: "{sectionRef}-{rowId}-{number}" e.g. "N-A-12B".
 * Must be unique within the layout and stable across layout versions
 * for the same physical seat (Seat Inventory uses it as a stable key).
 */
export interface Seat {
  seatId: string;
  row: string;
  number: string;
  type: SeatType;
  svgX: number;
  svgY: number;
}

export interface Row {
  rowId: string;
  label: string;
  seats: Seat[];
}

export interface LayoutSection {
  sectionRef: string;
  name: string;
  colour?: string;
  rows: Row[];
}

@Schema({
  collection: 'seating_layouts',
  toJSON: { getters: true, virtuals: false },
  toObject: { getters: true, virtuals: false },
})
export class SeatingLayout {
  @Prop({ type: String, required: true, unique: true })
  layoutId!: string;

  @Prop({ type: String, required: true, index: true })
  venueId!: string;

  /** Auto-incremented per venue. Never reused. */
  @Prop({ type: Number, required: true })
  version!: number;

  /** Computed at creation: sum of all seats across all sections and rows. */
  @Prop({ type: Number, required: true, min: 0 })
  totalSeats!: number;

  /**
   * Set to true by the service when the first ticket is sold against this version.
   * Once true, writes to `sections` are rejected with 409 Conflict.
   * Enforced at the application layer — there is no MongoDB-level constraint.
   * (See ER diagram §6: Security Controls, control C-02.)
   */
  @Prop({ type: Boolean, default: false })
  immutable!: boolean;

  /**
   * The full seat tree: Sections → Rows → Seats.
   * Stored as a mixed/untyped BSON object because the nested array-of-objects
   * structure is cumbersome to model with Mongoose nested schemas for a value
   * that is always read whole and never queried by sub-fields.
   *
   * Known size constraint: ~5MB for a 50,000-seat venue at 100 bytes/seat.
   * MongoDB 16MB document limit is not approached at current scale.
   * PHASE 7 TODO: monitor document sizes in production; if seat metadata grows,
   * migrate to a layout_seats collection (Option C).
   */
  @Prop({ type: Object, required: true })
  sections!: LayoutSection[];

  @Prop({ type: Date, default: () => new Date() })
  createdAt!: Date;

  @Prop({ type: String, default: '1.0.0' })
  schemaVersion!: string;
}

export const SeatingLayoutSchema = SchemaFactory.createForClass(SeatingLayout);

SeatingLayoutSchema.index({ venueId: 1, version: -1 });
