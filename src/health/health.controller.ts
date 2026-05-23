import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { KafkaService } from '../kafka/kafka.service';

interface HealthStatus {
  status: 'UP' | 'DOWN' | 'DEGRADED';
  checks: Record<string, string>;
}

/**
 * Health endpoints per venue.yaml (security: []) — unauthenticated.
 * JwtAuthGuard skips these paths (see publicPaths in jwt-auth.guard.ts).
 *
 * /health/live  → Is the process alive? Returns UP if the Node process is running.
 *                 Used by Kubernetes liveness probe to decide whether to restart the pod.
 *
 * /health/ready → Is the service ready to serve traffic? Checks MongoDB connectivity.
 *                 Used by Kubernetes readiness probe to decide whether to route traffic.
 *
 * These have distinct semantics. A pod can be alive but not ready (MongoDB reconnecting).
 * Kubernetes handles each differently — liveness failure = restart, readiness failure = remove from load balancer.
 */
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly kafkaService: KafkaService,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  liveness(): HealthStatus {
    return { status: 'UP', checks: { process: 'UP' } };
  }

  @Get('ready')
  async readiness(): Promise<HealthStatus> {
    const checks: Record<string, string> = {};

    // MongoDB: STATES.connected = 1
    checks['mongodb'] = this.connection.readyState === 1 ? 'UP' : 'DOWN';

    const allUp = Object.values(checks).every((v) => v === 'UP');
    const anyDown = Object.values(checks).some((v) => v === 'DOWN');

    return {
      status: anyDown ? 'DOWN' : allUp ? 'UP' : 'DEGRADED',
      checks,
    };
  }
}
