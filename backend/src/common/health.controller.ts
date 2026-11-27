import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { API_URLS } from '../../../shared/src/config/constants';
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
	@Get('tbc') async tbc() {
		try {
			const response = await fetch(API_URLS.nodeInfo, {
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(8_000),
			});
			if (!response.ok) throw new Error('TBC API unavailable.');
			await response.body?.cancel();
		} catch { throw new ServiceUnavailableException('TBC Testnet API unavailable.'); }
		return { data: { status: 'ok' } };
	}
}
