import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../types/jwt-payload.types';

export const ROLES_KEY = 'roles';

/**
 * Declares which roles are permitted for an endpoint.
 * Enforced by RolesGuard. Applied after JwtAuthGuard validates the token.
 *
 * Usage: @Roles(UserRole.VENUE, UserRole.ADMIN)
 */
export const Roles = (...roles: UserRole[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(ROLES_KEY, roles);
