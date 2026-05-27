import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import mongoose, { Connection, Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { OutboxService } from '../outbox/outbox.service';
import { AuthenticatedUser, UserRole } from '../common/types/jwt-payload.types';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { Venue, VenueDocument, VenueStatus } from './schemas/venue.schema';

@Injectable()
export class VenuesService {
  private readonly logger = new Logger(VenuesService.name);

  constructor(
    @InjectModel(Venue.name) private readonly venueModel: Model<VenueDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly outboxService: OutboxService,
  ) {}

  async create(
    dto: CreateVenueDto,
    actor: AuthenticatedUser,
    idempotencyKey?: string,
  ): Promise<VenueDocument> {
    if (idempotencyKey) {
      const existing = await this.venueModel.findOne({ idempotencyKey }).exec();
      if (existing) {
        this.logger.log(`Idempotency hit on createVenue: key=${idempotencyKey}`);
        return existing;
      }
    }

    const venueId = uuidv4();

    const session = await this.connection.startSession();
    try {
      session.startTransaction();

      const [venue] = await this.venueModel.create(
        [
          {
            venueId,
            ownerId: actor.userId,
            ...dto,
            status: 'PENDING_KYC' as VenueStatus,
            schemaVersion: '1.0.0',
          },
        ],
        { session },
      );

      await this.outboxService.create(session, {
        aggregateType: 'Venue',
        aggregateId: venueId,
        eventType: 'VenueCreated',
        payload: {
          messageId: uuidv4(),
          venueId,
          ownerId: actor.userId,
          name: dto.name,
          city: dto.city,
          totalCapacity: dto.totalCapacity,
          status: 'PENDING_KYC',
          createdAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
        },
      });

      await session.commitTransaction();
      return venue;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async findAll(
    actor: AuthenticatedUser,
    options: { city?: string; status?: VenueStatus; cursor?: string; pageSize?: number },
  ): Promise<{ items: VenueDocument[]; nextCursor: string | null }> {
    const { city, status, cursor, pageSize = 20 } = options;
    const limit = Math.min(pageSize, 100);

    const filter: mongoose.FilterQuery<Venue> = {};

    // Role-scoped filtering (venue.yaml listVenues description):
    // VENUE actor: own venues only.
    // ORGANISER / CUSTOMER: ACTIVE venues for discovery.
    // ADMIN: all venues.
    if (actor.role === UserRole.VENUE) {
      filter.ownerId = actor.userId;
    } else if (actor.role === UserRole.CUSTOMER || actor.role === UserRole.ORGANISER) {
      filter.status = 'ACTIVE';
    }
    // ADMIN: no filter — all venues visible.

    if (city) filter.city = city;
    if (status && actor.role === UserRole.ADMIN) filter.status = status;
    if (cursor) filter._id = { $gt: new mongoose.Types.ObjectId(cursor) };

    const items = await this.venueModel.find(filter).sort({ _id: 1 }).limit(limit).exec();

    const nextCursor =
      items.length === limit
        ? (items[items.length - 1]._id as mongoose.Types.ObjectId).toString()
        : null;

    return { items, nextCursor };
  }

  async findOne(venueId: string, actor: AuthenticatedUser): Promise<VenueDocument> {
    const venue = await this.venueModel.findOne({ venueId }).exec();

    if (!venue) {
      throw new NotFoundException('Venue not found');
    }

    // NFR-SEC-004: Tenant isolation. VENUE actor can only see own venues.
    // Return 404 — not 403 — to avoid leaking that the venue exists.
    // Note: venue.yaml description says 403, but NFR-SEC-004 and platform
    // convention (Event Service precedent) require 404. NFR wins.
    if (actor.role === UserRole.VENUE && venue.ownerId !== actor.userId) {
      this.logger.warn(
        `Tenant isolation violation: userId=${actor.userId} attempted access to venueId=${venueId}`,
      );
      throw new NotFoundException('Venue not found');
    }

    return venue;
  }

  async update(
    venueId: string,
    dto: UpdateVenueDto,
    actor: AuthenticatedUser,
    _idempotencyKey?: string,
  ): Promise<VenueDocument> {
    const venue = await this.venueModel.findOne({ venueId }).exec();
    if (!venue) throw new NotFoundException('Venue not found');

    // Only VENUE actor (own venue) or ADMIN may update.
    if (actor.role === UserRole.VENUE && venue.ownerId !== actor.userId) {
      throw new NotFoundException('Venue not found');
    }
    if (actor.role !== UserRole.VENUE && actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Insufficient role');
    }

    const updatedFields: string[] = [];
    if (dto.name !== undefined) {
      venue.name = dto.name;
      updatedFields.push('name');
    }
    if (dto.city !== undefined) {
      venue.city = dto.city;
      updatedFields.push('city');
    }
    if (dto.address !== undefined) {
      venue.address = dto.address;
      updatedFields.push('address');
    }
    if (dto.facilities !== undefined) {
      venue.facilities = dto.facilities;
      updatedFields.push('facilities');
    }
    if (dto.photoUrls !== undefined) {
      venue.photoUrls = dto.photoUrls;
      updatedFields.push('photoUrls');
    }

    const session = await this.connection.startSession();
    try {
      session.startTransaction();
      await venue.save({ session });

      await this.outboxService.create(session, {
        aggregateType: 'Venue',
        aggregateId: venueId,
        eventType: 'VenueUpdated',
        payload: {
          messageId: uuidv4(),
          venueId,
          updatedFields,
          venueName: dto.name ?? null,
          venueCity: dto.city ?? null,
          totalCapacity: null,
          updatedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
        },
      });

      await session.commitTransaction();
      return venue;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Admin-only: suspend a venue.
   * Publishing VenueSuspended triggers the Level 1 cascade (venue_async.yaml).
   *
   * PHASE 4 TODO: the full cascade (Event Service consuming VenueSuspended and
   * cancelling upstream events) is implemented when the Event Service consumer
   * is wired in Phase 4.
   */
  async suspend(venueId: string, adminId: string, reason: string): Promise<VenueDocument> {
    const venue = await this.venueModel.findOne({ venueId }).exec();
    if (!venue) throw new NotFoundException('Venue not found');

    if (venue.status === 'SUSPENDED') {
      return venue; // idempotent — already suspended
    }

    const session = await this.connection.startSession();
    try {
      session.startTransaction();
      venue.status = 'SUSPENDED';
      await venue.save({ session });

      await this.outboxService.create(session, {
        aggregateType: 'Venue',
        aggregateId: venueId,
        eventType: 'VenueSuspended',
        payload: {
          messageId: uuidv4(),
          venueId,
          adminId,
          reason,
          suspendedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
        },
      });

      await session.commitTransaction();
      return venue;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /** Used internally by SeatingLayoutsService to update latestLayoutId after a new layout is created. */
  async setLatestLayoutId(
    venueId: string,
    layoutId: string,
    session: mongoose.ClientSession,
  ): Promise<void> {
    await this.venueModel.updateOne(
      { venueId },
      { $set: { latestLayoutId: layoutId } },
      { session },
    );
  }
}
