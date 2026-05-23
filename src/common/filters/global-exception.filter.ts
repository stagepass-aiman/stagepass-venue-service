import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  traceId: string;
}

/**
 * Maps all exceptions to Problem Details format (RFC 9457).
 * Every error response is structured JSON with Content-Type: application/problem+json.
 *
 * The traceId field is populated from the X-Trace-Id request header,
 * which is set by the API Gateway and propagated through OTel context.
 * If absent, a placeholder is used — the real trace ID comes from Jaeger.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail = 'An unexpected error occurred.';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      title = exception.name;
      detail =
        typeof body === 'string'
          ? body
          : (body as { message?: string | string[] }).message
            ? Array.isArray((body as { message: string[] }).message)
              ? (body as { message: string[] }).message.join('; ')
              : ((body as { message: string }).message ?? detail)
            : detail;
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled exception: ${exception.message}`, exception.stack);
    }

    const traceId = (request.headers['x-trace-id'] as string | undefined) ?? 'unknown';

    const body: ProblemDetail = {
      type: `https://stagepass.dev/errors/${status}`,
      title,
      status,
      detail,
      instance: request.url,
      traceId,
    };

    response
      .status(status)
      .setHeader('Content-Type', 'application/problem+json')
      .json(body);
  }
}
