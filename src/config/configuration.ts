import * as Joi from 'joi';

export const validationSchema = Joi.object({
  PORT: Joi.number().default(8083),
  MONGODB_URI: Joi.string().required(),
  KAFKA_BROKERS: Joi.string().default('kafka:9092'),
  AUTH_JWKS_URI: Joi.string().uri().required(),
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().uri().default('http://otel-collector:4318'),
  OTEL_SERVICE_NAME: Joi.string().default('venue-service'),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
});

/**
 * Typed configuration object. Access via ConfigService.get<string>('kafka.brokers').
 *
 * Why this pattern (factory function returning a nested object):
 * Flat env vars are stringly-typed and scatter config access throughout the codebase.
 * The factory function maps flat env vars to a typed, nested config object.
 * ConfigService.get<T>() then provides type safety and IntelliSense.
 */
export default (): Record<string, unknown> => ({
  port: parseInt(process.env['PORT'] ?? '8083', 10),
  mongodb: {
    uri: process.env['MONGODB_URI'],
  },
  kafka: {
    // RULE-16: inside Docker, use the internal Kafka listener (kafka:9092).
    // localhost:9092 refers to the container itself — not the Kafka broker.
    brokers: (process.env['KAFKA_BROKERS'] ?? 'kafka:9092').split(','),
    clientId: 'venue-service',
    groupId: 'venue-service-consumer',
  },
  auth: {
    jwksUri: process.env['AUTH_JWKS_URI'],
  },
  otel: {
    endpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://otel-collector:4318',
    serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'venue-service',
  },
});
