import { Global, Module } from '@nestjs/common';
import { JwksService } from './jwks.service';

/**
 * @Global so that JwksService is available to JwtAuthGuard everywhere
 * without re-importing this module in every feature module.
 *
 * Why @Global here and not @Global on every guard:
 * Guards are not providers — they don't participate in DI by default.
 * JwksService IS a provider. Making its module global means NestJS's
 * DI container can inject it wherever it's needed without each module
 * declaring it as an import. The guard imports JwksService by constructor
 * injection, which works because the global module populates the root scope.
 *
 * RULE-09: In TestingModule, @Global modules don't auto-populate.
 * Integration tests must declare JwksService explicitly in providers[].
 */
@Global()
@Module({
  providers: [JwksService],
  exports: [JwksService],
})
export class JwksModule {}
