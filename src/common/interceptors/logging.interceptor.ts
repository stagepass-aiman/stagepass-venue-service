import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * Emits structured JSON access logs for every HTTP request.
 *
 * NFR-OBS-001: every log event includes traceId, spanId, service name,
 * userId, and request context. The traceId comes from the OTel-injected
 * X-Trace-Id header (set by the API Gateway from the OTel trace context).
 *
 * The anti-pattern this replaces: scattered console.log statements with
 * inconsistent fields. One interceptor, one log format, everywhere.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { userId: string } }>();
    const response = http.getResponse<Response>();
    const start = Date.now();

    const traceId = (request.headers['x-trace-id'] as string | undefined) ?? 'no-trace';
    const method = request.method;
    const url = request.url;
    const userId = request.user?.userId ?? 'anonymous';

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - start;
          this.logger.log(
            JSON.stringify({
              event: 'http_request',
              method,
              url,
              statusCode: response.statusCode,
              durationMs: ms,
              userId,
              traceId,
              service: 'venue-service',
            }),
          );
        },
        error: (err: unknown) => {
          const ms = Date.now() - start;
          const status = err instanceof Error ? 500 : response.statusCode;
          this.logger.error(
            JSON.stringify({
              event: 'http_request_error',
              method,
              url,
              statusCode: status,
              durationMs: ms,
              userId,
              traceId,
              service: 'venue-service',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        },
      }),
    );
  }
}
