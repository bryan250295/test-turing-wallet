import { Global, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { databaseAdapter } from './adapter';
import { PrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
	constructor() { super({ adapter: databaseAdapter() }); }
	async onModuleInit() { await this.$connect(); }
	async onModuleDestroy() { await this.$disconnect(); }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class DatabaseModule {}
