import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedUser, UserRole } from '../common/types/jwt-payload.types';
import { VenuesService } from '../venues/venues.service';
import { CreateLayoutDto } from './dto/create-layout.dto';
import { LayoutSection, SeatingLayout, SeatingLayoutDocument } from './schemas/seating-layout.schema';

/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

@Injectable()
export class SeatingLayoutsService {
  private readonly logger = new Logger(SeatingLayoutsService.name);

  constructor(
    @InjectModel(SeatingLayout.name) private readonly layoutModel: Model<SeatingLayoutDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly venuesService: VenuesService,
  ) {}

  async listForVenue(venueId: string, actor: AuthenticatedUser): Promise<SeatingLayoutDocument[]> {
    // Verifying the venue exists and the actor can see it (tenant isolation)
    await this.venuesService.findOne(venueId, actor);
    return this.layoutModel.find({ venueId }).sort({ version: -1 }).exec();
  }

  async create(
    venueId: string,
    dto: CreateLayoutDto,
    actor: AuthenticatedUser,
  ): Promise<SeatingLayoutDocument> {
    const venue = await this.venuesService.findOne(venueId, actor);

    if (actor.role === UserRole.VENUE && venue.ownerId !== actor.userId) {
      throw new NotFoundException('Venue not found');
    }

    // Compute version number: latest version + 1.
    const latest = await this.layoutModel.findOne({ venueId }).sort({ version: -1 }).exec();
    const version = (latest?.version ?? 0) + 1;

    // Compute totalSeats from the section tree.
    const totalSeats = (dto.sections as LayoutSection[]).reduce(
      (sum, s) => sum + s.rows.reduce((rSum, r) => rSum + r.seats.length, 0),
      0,
    );

    const layoutId = uuidv4();

    const session = await this.connection.startSession();
    try {
      session.startTransaction();

      const [layout] = await this.layoutModel.create(
        [
          {
            layoutId,
            venueId,
            version,
            totalSeats,
            immutable: false,
            sections: dto.sections,
            schemaVersion: '1.0.0',
          },
        ],
        { session },
      );

      // Update the venue's latestLayoutId atomically in the same transaction.
      await this.venuesService.setLatestLayoutId(venueId, layoutId, session);

      await session.commitTransaction();
      this.logger.log(`Layout v${version} created for venue ${venueId}`);
      return layout;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async findOne(
    venueId: string,
    layoutId: string,
    actor: AuthenticatedUser,
  ): Promise<SeatingLayoutDocument> {
    await this.venuesService.findOne(venueId, actor);
    const layout = await this.layoutModel.findOne({ layoutId, venueId }).exec();
    if (!layout) throw new NotFoundException('Seating layout not found');
    return layout;
  }

  /**
   * Marks a layout version as immutable.
   * Called when the Seat Inventory Service notifies that the first ticket
   * has been sold against this layout version.
   *
   * PHASE 4 TODO: implement Kafka consumer for TicketFirstSoldForLayout event
   * (or equivalent signal from Seat Inventory Service) to call this method.
   */
  async markImmutable(layoutId: string): Promise<void> {
    await this.layoutModel.updateOne({ layoutId }, { $set: { immutable: true } });
    this.logger.log(`Layout ${layoutId} marked as immutable (first ticket sold)`);
  }
}
