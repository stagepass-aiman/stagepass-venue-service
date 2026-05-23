import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser, UserRole } from '../types/jwt-payload.types';

/**
 * Enforces role-based access control at the service layer.
 *
 * Why service-layer RBAC (not just gateway):
 * NFR-SEC-003: RBAC must be enforced at the service layer. The API Gateway
 * can be bypassed by internal callers or misconfiguration. Each service is
 * the authoritative owner of its resources and must not trust that the
 * gateway already filtered by role.
 *
 * If no @Roles() decorator is present, the endpoint is accessible by any
 * authenticated user (the JWT guard still runs).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() decorator — any authenticated user may access.
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user: AuthenticatedUser }>();
    const user = request.user;

    if (!user || !requiredRoles.includes(user.role)) {
      // NFR-SEC-003: role violations are Forbidden (403), not 404.
      // 404 is reserved for tenant isolation violations where we don't want
      // to reveal the resource exists. Role violations don't leak resource existence
      // — the user knows they called an endpoint that requires a different role.
      throw new ForbiddenException('Insufficient role for this operation');
    }

    return true;
  }
}
