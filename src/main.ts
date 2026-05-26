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
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable MongoDB OTel instrumentation — incompatible with Mongoose 8 / MongoDB driver v6.
      //
      // Root cause: @opentelemetry/instrumentation-mongodb wraps db.command() responses
      // and calls response.toObject() expecting a Mongoose document. MongoDB driver v6
      // returns plain objects from command(), not Mongoose documents. toObject() does not
      // exist on plain objects → "response.toObject is not a function" on every command.
      //
      // Impact: every db.command() call fails — including syncIndexes() (which calls
      // listIndexes internally), isMaster, hello, and createCollection. This breaks
      // the entire startup collection creation sequence.
      //
      // Fix: disable MongoDB instrumentation entirely. HTTP, NestJS, Kafka, and all
      // other instrumentations continue to work. MongoDB-level traces are absent in
      // Jaeger until this is resolved.
      //
      // PHASE 7 TODO: upgrade @opentelemetry/instrumentation-mongodb to a version
      // compatible with MongoDB driver v6 and Mongoose 8, then re-enable.
      '@opentelemetry/instrumentation-mongodb': { enabled: false },
    }),
  ],
});

sdk.start();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { collectDefaultMetrics, Registry } from 'prom-client';
import { Connection } from 'mongoose';
import { Request, Response } from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
    bufferLogs: false,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  const register = new Registry();
  collectDefaultMetrics({ register, prefix: 'venue_' });

  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/metrics', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  await app.init();

  // Pre-create all collections and indexes before any request or cron fires (RULE-27).
  //
  // With MongoDB OTel instrumentation disabled (see above), syncIndexes() now works
  // correctly. It calls listIndexes() on each registered collection. For non-existent
  // collections this returns an empty cursor, and syncIndexes() then creates the
  // collection and its indexes implicitly.
  //
  // Retry loop: syncIndexes() requires PRIMARY state (it performs write operations
  // internally). The loop retries until the replica set election completes or timeout.
  const mongoConnection = app.get<Connection>(getConnectionToken());
  let synced = false;
  let attempt = 0;
  const maxAttempts = 60; // 60 × 2s = 120s maximum wait

  while (!synced && attempt < maxAttempts) {
    try {
      await mongoConnection.syncIndexes();
      synced = true;
    } catch (err) {
      attempt++;
      console.log(
        JSON.stringify({
          event: 'sync_indexes_waiting',
          attempt,
          maxAttempts,
          error: err instanceof Error ? err.message : String(err),
          service: 'venue-service',
          timestamp: new Date().toISOString(),
        }),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    }
  }

  if (!synced) {
    throw new Error(
      `syncIndexes failed after ${maxAttempts * 2}s — MongoDB replica set may not have reached PRIMARY state`,
    );
  }

  console.log(
    JSON.stringify({
      event: 'collections_synced',
      service: 'venue-service',
      timestamp: new Date().toISOString(),
    }),
  );

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