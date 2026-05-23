import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer, ProducerRecord } from 'kafkajs';

/**
 * Thin wrapper around the KafkaJS producer.
 *
 * Why a wrapper and not direct KafkaJS usage:
 * Centralises connect/disconnect lifecycle and makes testing trivial —
 * mock KafkaService.send() rather than the KafkaJS internals.
 * The OutboxPublisher calls KafkaService.send(); it doesn't know or care
 * about the KafkaJS API shape.
 */
@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private producer!: Producer;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const brokers = this.config.get<string[]>('kafka.brokers') ?? ['kafka:9092'];
    const clientId = this.config.get<string>('kafka.clientId') ?? 'venue-service';

    const kafka = new Kafka({ clientId, brokers });
    this.producer = kafka.producer({
      // Idempotent producer: exactly-once delivery from the producer side.
      // The broker deduplicates retransmitted messages using the sequence number.
      // This doesn't prevent duplicate consumption — consumers must still be idempotent.
      idempotent: true,
      maxInFlightRequests: 1, // required when idempotent: true
    });

    await this.producer.connect();
    this.logger.log(`Kafka producer connected → ${brokers.join(',')}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    this.logger.log('Kafka producer disconnected (graceful shutdown)');
  }

  async send(topic: string, message: ProducerRecord['messages'][0]): Promise<void> {
    await this.producer.send({ topic, messages: [message] });
  }
}

@Global()
@Module({
  providers: [KafkaService],
  exports: [KafkaService],
})
export class KafkaModule {}
