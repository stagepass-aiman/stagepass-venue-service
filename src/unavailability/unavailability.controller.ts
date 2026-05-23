import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser, UserRole } from '../common/types/jwt-payload.types';
import { CreateUnavailabilityDto } from './dto/create-unavailability.dto';
import { UnavailabilityService } from './unavailability.service';

/**
 * Mounted at 'venues/:venueId/unavailability'.
 * Same pattern as SeatingLayoutsController: sibling module, nested path.
 * See SeatingLayoutsController for the routing rationale.
 */
@Controller('venues/:venueId/unavailability')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UnavailabilityController {
  constructor(private readonly unavailabilityService: UnavailabilityService) {}

  /** POST /venues/:venueId/unavailability — Block dates (VENUE own only) */
  @Post()
  @Roles(UserRole.VENUE, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async addUnavailability(
    @Param('venueId') venueId: string,
    @Body() dto: CreateUnavailabilityDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<unknown> {
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
    return this.unavailabilityService.create(venueId, dto, actor, idempotencyKey);
  }
}
