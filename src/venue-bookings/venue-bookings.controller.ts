import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { CreateVenueBookingDto } from './dto/create-venue-booking.dto';
import { RejectVenueBookingDto } from './dto/reject-venue-booking.dto';
import { VenueBookingStatus } from './schemas/venue-booking.schema';
import { VenueBookingsService } from './venue-bookings.service';

@Controller('venue-bookings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VenueBookingsController {
  constructor(private readonly venueBookingsService: VenueBookingsService) {}

  /** POST /venue-bookings — Submit booking request (ORGANISER only) */
  @Post()
  @Roles(UserRole.ORGANISER)
  @HttpCode(HttpStatus.CREATED)
  async requestVenueBooking(
    @Body() dto: CreateVenueBookingDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<unknown> {
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
    return this.venueBookingsService.create(dto, actor, idempotencyKey);
  }

  /** GET /venue-bookings — List bookings (role-scoped) */
  @Get()
  async listVenueBookings(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('status') status?: VenueBookingStatus,
    @Query('venueId') venueId?: string,
    @Query('cursor') cursor?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.venueBookingsService.findAll(actor, {
      status,
      venueId,
      cursor,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  /**
   * GET /venue-bookings/:vbId — Get a single booking.
   *
   * A venue-booking is a private two-party negotiation (Organiser ⇄ Venue) plus
   * Admin. CUSTOMER is never a party, so it is excluded from @Roles → RolesGuard
   * returns 403 BEFORE any lookup (wrong role: nothing to conceal, NFR-SEC-003).
   * For the named roles, VenueBookingsService.findOne() then applies object-level
   * authorization → 404 for a non-party Organiser/Venue (NFR-SEC-004).
   * venue.yaml documents both 403 and 404 for this endpoint; both are now enforced.
   */
  @Get(':vbId')
  @Roles(UserRole.ORGANISER, UserRole.VENUE, UserRole.ADMIN)
  async getVenueBooking(
    @Param('vbId') vbId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<unknown> {
    return this.venueBookingsService.findOne(vbId, actor);
  }

  /** POST /venue-bookings/:vbId/accept — Accept (VENUE own only) */
  @Post(':vbId/accept')
  @Roles(UserRole.VENUE, UserRole.ADMIN)
  async acceptVenueBooking(
    @Param('vbId') vbId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<unknown> {
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
    return this.venueBookingsService.accept(vbId, actor, idempotencyKey);
  }

  /** POST /venue-bookings/:vbId/reject — Reject (VENUE own only) */
  @Post(':vbId/reject')
  @Roles(UserRole.VENUE, UserRole.ADMIN)
  async rejectVenueBooking(
    @Param('vbId') vbId: string,
    @Body() dto: RejectVenueBookingDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<unknown> {
    return this.venueBookingsService.reject(vbId, dto, actor);
  }
}
