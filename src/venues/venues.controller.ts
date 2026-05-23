import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser, UserRole } from '../common/types/jwt-payload.types';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { VenuesService } from './venues.service';
import { VenueStatus } from './schemas/venue.schema';

@Controller('venues')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VenuesController {
  constructor(private readonly venuesService: VenuesService) {}

  /** POST /venues — Register a new Venue (VENUE role only) */
  @Post()
  @Roles(UserRole.VENUE)
  @HttpCode(HttpStatus.CREATED)
  async createVenue(
    @Body() dto: CreateVenueDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<unknown> {
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
    return this.venuesService.create(dto, actor, idempotencyKey);
  }

  /** GET /venues — List venues (role-scoped) */
  @Get()
  async listVenues(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('city') city?: string,
    @Query('status') status?: VenueStatus,
    @Query('cursor') cursor?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.venuesService.findAll(actor, {
      city,
      status,
      cursor,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  /** GET /venues/:venueId — Get a single venue */
  @Get(':venueId')
  async getVenue(
    @Param('venueId') venueId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<unknown> {
    return this.venuesService.findOne(venueId, actor);
  }

  /** PUT /venues/:venueId — Update venue profile (VENUE own, ADMIN) */
  @Put(':venueId')
  @Roles(UserRole.VENUE, UserRole.ADMIN)
  async updateVenue(
    @Param('venueId') venueId: string,
    @Body() dto: UpdateVenueDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<unknown> {
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
    return this.venuesService.update(venueId, dto, actor, idempotencyKey);
  }

  /**
   * GET /venues/:venueId/revenue — Venue revenue summary (VENUE own only)
   *
   * PHASE 4 TODO: this stub returns an empty list. Real revenue data comes
   * from the Disbursement Service ledger. In Phase 4, when Disbursement Service
   * is built, implement either:
   *   (a) A REST call from Venue Service → Disbursement Service, or
   *   (b) A read model populated via Kafka (DisbursementCompleted events).
   * Option (b) is preferred to avoid synchronous coupling between T2 and T1 services.
   */
  @Get(':venueId/revenue')
  @Roles(UserRole.VENUE, UserRole.ADMIN)
  async getVenueRevenue(
    @Param('venueId') venueId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    await this.venuesService.findOne(venueId, actor);
    return { items: [], nextCursor: null };
  }
}
