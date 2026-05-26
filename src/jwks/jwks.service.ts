import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { JwtPayload } from '../common/types/jwt-payload.types';

/**
 * Validates RS256 JWTs locally using cached JWKS public keys.
 *
 * Why local validation (no per-request Auth Service call):
 * ADR-003 §3.1: per-request auth calls create a synchronous dependency that
 * turns Auth Service downtime into a platform-wide outage. RS256 allows every
 * service to verify signatures independently using the public key from JWKS.
 * The only latency cost is the initial JWKS fetch at startup.
 *
 * Cache strategy: jwks-rsa caches keys by `kid`. On an unknown kid
 * (e.g. after a key rotation), the client re-fetches the JWKS endpoint.
 * jwks-rsa handles this transparently via its built-in cache + rate limiting.
 */
@Injectable()
export class JwksService implements OnModuleInit {
  private readonly logger = new Logger(JwksService.name);
  private client!: ReturnType<typeof jwksRsa>;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const jwksUri = this.config.get<string>('auth.jwksUri');
    if (!jwksUri) {
      throw new Error('AUTH_JWKS_URI is not configured');
    }

    this.client = jwksRsa({
      jwksUri,
      // Cache: keys are stable between rotations. 10 min TTL is sufficient.
      cache: true,
      cacheMaxAge: 10 * 60 * 1000,
      // Rate-limit re-fetch on unknown kid to prevent hammering Auth Service
      // during a thundering herd after key rotation.
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });

    this.logger.log(`JWKS client initialised → ${jwksUri}`);
  }

  /**
   * Validates the JWT and returns the decoded payload.
   * Throws if the token is expired, has an invalid signature, or is malformed.
   *
   * The caller (JwtAuthGuard) is responsible for mapping thrown errors
   * to 401 Unauthorized responses.
   */
  async validateToken(token: string): Promise<JwtPayload> {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
      throw new Error('Malformed JWT: missing header or kid');
    }

    const key = await this.client.getSigningKey(decoded.header.kid);
    const publicKey = key.getPublicKey();

    // jwt.verify throws on expiry, invalid signature, wrong algorithm.
    // We let the error propagate — JwtAuthGuard catches it and returns 401.
    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
    }) as JwtPayload;

    return payload;
  }
}
