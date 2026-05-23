import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwksService } from '../../jwks/jwks.service';
import { AuthenticatedUser } from '../types/jwt-payload.types';

/**
 * Validates the Bearer JWT on every protected request.
 *
 * On success: attaches the decoded payload to request.user so that
 * @CurrentUser() and RolesGuard can access it without re-parsing the token.
 *
 * On failure: throws UnauthorizedException → GlobalExceptionFilter → 401.
 *
 * Applied globally in main.ts via APP_GUARD. Endpoints that opt out
 * (health checks, JWKS endpoint) use @Public() decorator — not implemented
 * here since health uses security: [] in the OpenAPI spec and is mounted
 * on a separate controller. We skip the guard there by checking the path.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  // Health endpoints are unauthenticated per venue.yaml (security: [])
  private readonly publicPaths = ['/health/live', '/health/ready', '/metrics'];

  constructor(private readonly jwksService: JwksService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user: AuthenticatedUser }>();

    if (this.publicPaths.some((p) => request.path.startsWith(p))) {
      return true;
    }

    const token = this.extractBearer(request);
    if (!token) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    try {
      const payload = await this.jwksService.validateToken(token);
      request.user = {
        userId: payload.sub,
        email: payload.email,
        role: payload.role,
        displayName: payload.displayName,
        jti: payload.jti,
      };
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token validation failed';
      this.logger.warn(`JWT validation failed: ${message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractBearer(request: Request): string | undefined {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return undefined;
    return auth.slice(7);
  }
}
