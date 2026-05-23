import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedUser, UserRole } from '../common/types/jwt-payload.types';
import { VenuesService } from '../venues/venues.service';
import { CreateUnavailabilityDto } from './dto/create-unavailability.dto';
import {
  UnavailabilityWindow,
  UnavailabilityWindowDocument,
} from './schemas/unavailability-window.schema';

@Injectable()
export class UnavailabilityService {
  private readonly logger = new Logger(UnavailabilityService.name);

  constructor(
    @InjectModel(UnavailabilityWindow.name)
    private readonly windowModel: Model<UnavailabilityWindowDocument>,
    private readonly venuesService: VenuesService,
  ) {}

  async create(
    venueId: string,
    dto: CreateUnavailabilityDto,
    actor: AuthenticatedUser,
    idempotencyKey?: string,
  ): Promise<UnavailabilityWindowDocument> {
    // Idempotency check first.
    if (idempotencyKey) {
      const existing = await this.windowModel.findOne({ idempotencyKey }).exec();
      if (existing) return existing;
    }

    // Verify venue exists and actor can manage it.
    const venue = await this.venuesService.findOne(venueId, actor);
    if (actor.role === UserRole.VENUE && venue.ownerId !== actor.userId) {
      throw new NotFoundException('Venue not found');
    }

    const from = new Date(dto.fromDate);
    const to = new Date(dto.toDate);

    const [window] = await this.windowModel.create([
      {
        windowId: uuidv4(),
        venueId,
        fromDate: from,
        toDate: to,
        reason: dto.reason,
        idempotencyKey: idempotencyKey ?? null,
      },
    ]);

    this.logger.log(`Unavailability window created for venue ${venueId}: ${dto.fromDate} → ${dto.toDate}`);
    return window;
  }
}
