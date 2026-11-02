import { Module } from '@nestjs/common';
import { HtlcController } from './htlc.controller';
import { HtlcService } from './htlc.service';
import { HtlcRepository } from './htlc.repository';
import { SecretsRepository } from './secrets.repository';

@Module({ controllers: [HtlcController], providers: [HtlcService, HtlcRepository, SecretsRepository] })
export class HtlcModule {}
