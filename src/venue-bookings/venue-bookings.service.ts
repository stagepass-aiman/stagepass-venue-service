import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import mongoose, { Connection, Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedUser, UserRole } from '../common/types/jwt-payload.types';
import { OutboxService } from '../outbox/outbox.service';
import { VenuesService } from '../venues/venues.service';
import { UnavailabilityWindow } from '../unavailability/schemas/unavailability-window.schema';
import { CreateVenueBookingDto } from './dto/create-venue-booking.dto';
import { RejectVenueBookingDto } from './dto/reject-venue-booking.dto';
import {
  VenueBooking,
  VenueBookingDocument,
  VenueBookingStatus,
} from './schemas/venue-booking.schema';

@Injectable()
export class VenueBookingsService {
  private readonly logger = new Logger(VenueBookingsService.name);

  constructor(
    @InjectModel(VenueBooking.name) private readonly vbModel: Model<VenueBookingDocument>,
    @InjectModel(UnavailabilityWindow.name)
    private readonly unavailabilityModel: Model<mongoose.Document & UnavailabilityWindow>,
    @InjectConnection() private readonly connection: Connection,
    private readonly outboxService: OutboxService,
    private readonly venuesService: VenuesService,
  ) {}

  async create(
    dto: CreateVenueBookingDto,
    actor: AuthenticatedUser,
    idempotencyKey?: string,
  ): Promise<VenueBookingDocument> {
    // Idempotency: return existing booking for the same key.
    if (idempotencyKey) {
      const existing = await this.vbModel.findOne({ idempotencyKey }).exec();
      if (existing) return existing;
    }

    // Verify the target venue exists and is visible to this Organiser.
    // findOne() applies NFR-SEC-004 visibility: for an ORGANISER actor it returns
    // the venue ONLY if status === 'ACTIVE'. So a non-existent OR non-ACTIVE venue
    // yields 404 here — NOT 409. (A 409 "not available" would confirm the venue
    // exists to a caller who can't otherwise see it: an enumeration leak. This is
    // the deliberate 409→404 behaviour change that came with the findOne() fix.)
    const venue = await this.venuesService.findOne(dto.venueId, actor);

    // Defence in depth: assert the bookable invariant locally so create() does not
    // silently depend on findOne()'s visibility staying status-scoped. Redundant
    // for an ORGANISER today (findOne already filtered ACTIVE), but load-bearing
    // if this endpoint is ever opened to a role whose findOne() is not status-
    // filtered (e.g. ADMIN). Fails closed with 404, consistent with the above.
    if (venue.status !== 'ACTIVE') {
      throw new NotFoundException('Venue not found');
    }

    const from = new Date(dto.fromDate);
    const to = new Date(dto.toDate);

    // Check for unavailability window overlap.
    const windowConflict = await this.unavailabilityModel
      .findOne({
        venueId: dto.venueId,
        fromDate: { $lte: to },
        toDate: { $gte: from },
      })
      .exec();

    if (windowConflict) {
      throw new ConflictException('Venue is unavailable for the requested dates');
    }

    // Check for ACCEPTED/CONFIRMED booking overlap.
    const bookingConflict = await this.vbModel
      .findOne({
        venueId: dto.venueId,
        status: { $in: ['ACCEPTED', 'CONFIRMED'] },
        fromDate: { $lte: to },
        toDate: { $gte: from },
      })
      .exec();

    if (bookingConflict) {
      throw new ConflictException('Venue already has a confirmed booking for these dates');
    }

    const vbId = uuidv4();

    const [booking] = await this.vbModel.create([
      {
        vbId,
        venueId: dto.venueId,
        organiserId: actor.userId,
        fromDate: from,
        toDate: to,
        expectedAttendance: dto.expectedAttendance,
        eventType: dto.eventType,
        message: dto.message,
        status: 'REQUESTED',
        // Store as Decimal128. mongoose.Types.Decimal128.fromString() ensures
        // exact decimal representation without floating-point error.
        venueRevenueSharePercentage: mongoose.Types.Decimal128.fromString(
          dto.venueRevenueSharePercentage,
        ),
        idempotencyKey: idempotencyKey ?? null,
        schemaVersion: '1.0.0',
      },
    ]);

    return booking;
  }

  async findAll(
    actor: AuthenticatedUser,
    options: { status?: VenueBookingStatus; venueId?: string; cursor?: string; pageSize?: number },
  ): Promise<{ items: VenueBookingDocument[]; nextCursor: string | null }> {
    const { status, venueId, cursor, pageSize = 20 } = options;
    const limit = Math.min(pageSize, 100);
    const filter: mongoose.FilterQuery<VenueBooking> = {};

    if (actor.role === UserRole.ORGANISER) {
      filter.organiserId = actor.userId;
    } else if (actor.role === UserRole.VENUE) {
      // Venue actor sees requests to their own venues only.
      const ownedVenues = await this.getOwnedVenueIds(actor.userId);
      filter.venueId = { $in: ownedVenues };
    }
    // ADMIN: sees all. CUSTOMER: not a party — the list controller has no @Roles
    // gate, but a CUSTOMER reaching here matches none of the branches above and
    // so gets an unfiltered query. NOTE: listVenueBookings has no @Roles either;
    // hardening the list endpoint is tracked separately (out of scope for this
    // object-level fix, which targets read-by-id leaks).

    if (status) filter.status = status;
    if (venueId) filter.venueId = venueId;
    if (cursor) filter._id = { $gt: new mongoose.Types.ObjectId(cursor) };

    const items = await this.vbModel.find(filter).sort({ _id: 1 }).limit(limit).exec();
    const nextCursor =
      items.length === limit
        ? (items[items.length - 1]._id as mongoose.Types.ObjectId).toString()
        : null;

    return { items, nextCursor };
  }

  /**
   * Object-level visibility predicate for a single venue-booking (NFR-SEC-004).
   *
   * A venue-booking is a private negotiation between exactly two parties — the
   * requesting Organiser and the owning Venue — plus Admin oversight. The
   * predicate is an ALLOW-LIST (default-DENY): every role that may see it is
   * named; everyone else (notably CUSTOMER) returns false → 404.
   *
   *   ADMIN     → any booking
   *   ORGANISER → bookings they created (organiserId === userId)
   *   VENUE     → bookings targeting a venue they own
   *   else      → false (fail closed)
   *
   * The controller's @Roles(ORGANISER, VENUE, ADMIN) already 403s CUSTOMER before
   * this runs; we ALSO fail closed here so the method is safe regardless of how it
   * is called (defence in depth — NFR-SEC-003 mandates service-layer enforcement).
   */
  private async canView(booking: VenueBookingDocument, actor: AuthenticatedUser): Promise<boolean> {
    switch (actor.role) {
      case UserRole.ADMIN:
        return true;
      case UserRole.ORGANISER:
        return booking.organiserId === actor.userId;
      case UserRole.VENUE: {
        const ownedVenueIds = await this.getOwnedVenueIds(actor.userId);
        return ownedVenueIds.includes(booking.venueId);
      }
      default:
        return false;
    }
  }

  async findOne(vbId: string, actor: AuthenticatedUser): Promise<VenueBookingDocument> {
    const booking = await this.vbModel.findOne({ vbId }).exec();
    if (!booking) throw new NotFoundException('Venue booking not found');

    if (await this.canView(booking, actor)) {
      return booking;
    }

    this.logger.warn(
      `Tenant isolation: userId=${actor.userId} role=${actor.role} denied access to vbId=${vbId}`,
    );
    throw new NotFoundException('Venue booking not found');
  }

  async accept(
    vbId: string,
    actor: AuthenticatedUser,
    _idempotencyKey?: string,
  ): Promise<VenueBookingDocument> {
    const booking = await this.vbModel.findOne({ vbId }).exec();
    if (!booking) throw new NotFoundException('Venue booking not found');

    // Tenant isolation: only the Venue that owns the target venue (or ADMIN) can
    // accept. findOne() on the venue already 404s a VENUE actor who is not the
    // owner; the explicit check below is retained for clarity and ADMIN passthrough.
    const venue = await this.venuesService.findOne(booking.venueId, actor);
    if (actor.role === UserRole.VENUE && venue.ownerId !== actor.userId) {
      throw new NotFoundException('Venue booking not found');
    }

    if (booking.status === 'ACCEPTED') return booking; // idempotent

    if (booking.status !== 'REQUESTED') {
      throw new ConflictException(
        `Cannot accept a booking in status ${booking.status}. Expected REQUESTED.`,
      );
    }

    const session = await this.connection.startSession();
    try {
      session.startTransaction();

      booking.status = 'ACCEPTED';
      // venueRevenueSharePercentage is now IMMUTABLE — do not touch it.
      await booking.save({ session });

      await this.outboxService.create(session, {
        aggregateType: 'VenueBooking',
        aggregateId: vbId,
        eventType: 'VenueBookingAccepted',
        payload: {
          messageId: uuidv4(),
          venueBookingId: vbId,
          venueId: booking.venueId,
          organiserId: booking.organiserId,
          eventId: booking.eventId ?? null,
          eventDate: booking.fromDate.toISOString().slice(0, 10),
          // venueShareRate is the locked rate for all RevenueSplit computations.
          // It is read from the DB (already Decimal128), serialised as string.
          venueShareRate: booking.venueRevenueSharePercentage, // getter has already converted to string
          acceptedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
        },
      });

      await session.commitTransaction();
      return booking;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async reject(
    vbId: string,
    dto: RejectVenueBookingDto,
    actor: AuthenticatedUser,
  ): Promise<VenueBookingDocument> {
    const booking = await this.vbModel.findOne({ vbId }).exec();
    if (!booking) throw new NotFoundException('Venue booking not found');

    const venue = await this.venuesService.findOne(booking.venueId, actor);
    if (actor.role === UserRole.VENUE && venue.ownerId !== actor.userId) {
      throw new NotFoundException('Venue booking not found');
    }

    if (booking.status !== 'REQUESTED') {
      throw new ConflictException(
        `Cannot reject a booking in status ${booking.status}. Expected REQUESTED.`,
      );
    }

    const session = await this.connection.startSession();
    try {
      session.startTransaction();

      booking.status = 'REJECTED';
      booking.rejectionReason = dto.reason;
      await booking.save({ session });

      await this.outboxService.create(session, {
        aggregateType: 'VenueBooking',
        aggregateId: vbId,
        eventType: 'VenueBookingRejected',
        payload: {
          messageId: uuidv4(),
          venueBookingId: vbId,
          venueId: booking.venueId,
          organiserId: booking.organiserId,
          rejectionReason: dto.reason,
          rejectedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
        },
      });

      await session.commitTransaction();
      return booking;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /** Returns venueIds owned by this VENUE actor. Used for list + read-by-id scoping. */
  private async getOwnedVenueIds(ownerId: string): Promise<string[]> {
    // Delegate to the Venue model via venuesService's underlying model.
    // PHASE 4 TODO: expose findByOwner on VenuesService to avoid reaching
    // into venue data from this service. For now, the query is straightforward.
    const docs = await this.vbModel.db
      .collection('venues')
      .find({ ownerId }, { projection: { venueId: 1 } })
      .toArray();
    return docs.map((d) => d['venueId'] as string);
  }
}
