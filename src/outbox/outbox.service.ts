import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { Outbox, OutboxDocument } from './schemas/outbox.schema';

export interface CreateOutboxRecordDto {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Writes Outbox records within the caller's MongoDB transaction session.
 *
 * CRITICAL: the `session` parameter MUST be the same session as the one
 * used to write the business document (Venue, VenueBooking, etc.).
 * If you pass a different session or no session, the write is not part of
 * the business transaction and the dual-write problem re-emerges.
 *
 * Usage in a service method:
 *   const session = await this.connection.startSession();
 *   session.startTransaction();
 *   try {
 *     await venue.save({ session });                    // business write
 *     await this.outboxService.create(session, {...}); // event write — SAME session
 *     await session.commitTransaction();               // both commit atomically
 *   } catch { await session.abortTransaction(); }
 *   finally { await session.endSession(); }
 */
@Injectable()
export class OutboxService {
  constructor(@InjectModel(Outbox.name) private readonly outboxModel: Model<OutboxDocument>) {}

  async create(
    session: ClientSession,
    dto: CreateOutboxRecordDto,
  ): Promise<OutboxDocument> {
    const [record] = await this.outboxModel.create(
      [
        {
          outboxId: uuidv4(),
          aggregateType: dto.aggregateType,
          aggregateId: dto.aggregateId,
          eventType: dto.eventType,
          payload: dto.payload,
          status: 'PENDING',
          retryCount: 0,
          createdAt: new Date(),
          processedAt: null,
        },
      ],
      // Passing the session here is what makes this write atomic with the
      // business document write. This is the entire point of the Outbox pattern.
      { session },
    );
    return record;
  }
}
