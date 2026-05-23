/**
 * OpenTelemetry SDK must be initialised BEFORE any other imports.
 * The SDK instruments modules (http, mongoose, kafkajs) at require-time.
 * If you import NestJS or other modules first, instrumentation patches miss them.
 *
 * This is a known Node.js instrumentation constraint — not a NestJS quirk.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'venue-service',
  traceExporter: new OTLPTraceExporter({
    url: `${process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://otel-collector:4318'}/v1/traces`,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { collectDefaultMetrics, Registry } from 'prom-client';
import { Request, Response } from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Structured JSON logging. In production, pipe stdout to Loki via Promtail.
    logger: ['error', 'warn', 'log', 'debug'],
    bufferLogs: false,
  });

  // Global validation pipe — rejects requests that fail DTO validation.
  // whitelist: strips properties not declared in the DTO (defence against over-posting).
  // forbidNonWhitelisted: returns 400 if extra properties are present.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Problem Details RFC 9457 error format for all unhandled exceptions.
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Structured JSON access logs (NFR-OBS-001).
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Prometheus metrics on /metrics (NFR-OBS-002).
  // Scraped by Prometheus using the scrape config in stagepass-infrastructure.
  const register = new Registry();
  collectDefaultMetrics({ register, prefix: 'venue_' });

  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/metrics', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  const port = parseInt(process.env['PORT'] ?? '8083', 10);
  await app.listen(port);
  console.log(
    JSON.stringify({
      event: 'service_started',
      service: 'venue-service',
      port,
      timestamp: new Date().toISOString(),
    }),
  );
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
