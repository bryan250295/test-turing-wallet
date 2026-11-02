import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Controller('api/health')
export class HealthController {
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
	@Get('live') live() { return { data: { status: 'ok' } }; }
	@Get('ready') async ready() {
		try { await this.db.$queryRaw`SELECT 1`; }
		catch { throw new ServiceUnavailableException('Database unavailable.'); }
		return { data: { status: 'ok' } };
	}
}
