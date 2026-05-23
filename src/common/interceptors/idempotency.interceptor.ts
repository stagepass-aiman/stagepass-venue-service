import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * Implements the Idempotency-Key header pattern (NFR-REL-001).
 *
 * On a request with Idempotency-Key:
 *   - If the key has been seen before and the prior request succeeded,
 *     return the cached response immediately.
 *   - If the key is new, process normally and cache the response.
 *
 * Current implementation: in-memory Map with a 24h TTL.
 *
 * PHASE 7 TODO: replace with Redis-backed idempotency store so the cache
 * survives restarts and is shared across horizontally-scaled replicas.
 * The pattern is: SET idempotency:{key} {response} EX 86400 NX
 * (NX ensures exactly-once semantics under concurrent duplicate requests).
 *
 * Anti-pattern this prevents: a client double-submitting a venue creation
 * due to a network timeout would create two identical venues. The
 * Idempotency-Key makes the second request return the first venue.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  // Map<idempotencyKey, cachedResponseBody>
  // In production this must be Redis. The in-memory store is lost on restart.
  private readonly cache = new Map<string, unknown>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // Only intercept mutating methods (POST, PUT, PATCH)
    if (!['POST', 'PUT', 'PATCH'].includes(request.method)) {
      return next.handle();
    }

    const key = request.headers['idempotency-key'] as string | undefined;
    if (!key) {
      return next.handle();
    }

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.logger.log(`Idempotency cache hit: key=${key}`);
      response.status(200).json(cached);
      // Return an observable that completes immediately — NestJS won't re-send
      return new Observable((subscriber) => subscriber.complete());
    }

    return next.handle().pipe(
      tap({
        next: (data: unknown) => {
          this.cache.set(key, data);
          // Evict after 24 hours to prevent unbounded memory growth.
          // In Redis this is handled by EX 86400 on the SET command.
          setTimeout(() => this.cache.delete(key), 24 * 60 * 60 * 1000);
        },
      }),
    );
  }
}
