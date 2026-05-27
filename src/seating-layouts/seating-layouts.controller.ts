import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser, UserRole } from '../common/types/jwt-payload.types';
import { CreateLayoutDto } from './dto/create-layout.dto';
import { SeatingLayoutsService } from './seating-layouts.service';

/**
 * Mounted at 'venues/:venueId/layouts' — a nested path under the Venues resource.
 *
 * Why this controller is a sibling module (not nested inside VenuesModule):
 * Nesting would couple SeatingLayouts into VenuesModule, making VenuesModule
 * responsible for two distinct domain concerns. As a sibling, SeatingLayoutsModule
 * imports VenuesModule (for VenuesService, which it needs for tenant checks),
 * but the dependency is explicit and one-directional.
 *
 * How NestJS mounts this at a nested path without it being a child module:
 * @Controller('venues/:venueId/layouts') on the controller class is sufficient.
 * NestJS route registration is path-string-based — the module hierarchy is a
 * DI concern, not a routing concern. The router sees the full path; module
 * hierarchy is irrelevant to it.
 */
@Controller('venues/:venueId/layouts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SeatingLayoutsController {
  constructor(private readonly seatingLayoutsService: SeatingLayoutsService) {}

  /** GET /venues/:venueId/layouts */
  @Get()
  async listLayouts(
    @Param('venueId') venueId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<unknown> {
    const items = await this.seatingLayoutsService.listForVenue(venueId, actor);
    return { items };
  }

  /** POST /venues/:venueId/layouts — Create new layout version (VENUE own only) */
  @Post()
  @Roles(UserRole.VENUE, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async createLayout(
    @Param('venueId') venueId: string,
    @Body() dto: CreateLayoutDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<unknown> {
    return this.seatingLayoutsService.create(venueId, dto, actor);
  }

  /** GET /venues/:venueId/layouts/:layoutId */
  @Get(':layoutId')
  async getLayout(
    @Param('venueId') venueId: string,
    @Param('layoutId') layoutId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<unknown> {
    return this.seatingLayoutsService.findOne(venueId, layoutId, actor);
  }
}
