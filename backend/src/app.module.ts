import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './database/prisma.service';
import { AuthModule } from './auth/auth.module';
import { HtlcModule } from './htlc/htlc.module';
import { BridgeModule } from './bridge/bridge.module';
import { ActionLogController } from './common/action-log.controller';
import { HealthController } from './common/health.controller';

@Module({ imports: [DatabaseModule, AuthModule, HtlcModule, BridgeModule, ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 120 }])], controllers: [HealthController, ActionLogController], providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }] })
export class AppModule {}
