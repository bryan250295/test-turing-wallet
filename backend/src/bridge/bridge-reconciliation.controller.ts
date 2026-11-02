import { Controller, Get, Inject, Param, ParseUUIDPipe, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { SessionGuard } from '../auth/session.guard';
import { BridgeReconciliationService } from './bridge-reconciliation.service';
import { BridgeReconciliationBalancesService } from './bridge-reconciliation-balances.service';

@ApiTags('Learning Bridge') @ApiCookieAuth() @UseGuards(SessionGuard)
@Controller('api/bridge/reconciliation')
export class BridgeReconciliationController {
	constructor(@Inject(BridgeReconciliationService) private readonly report: BridgeReconciliationService,
		@Inject(BridgeReconciliationBalancesService) private readonly balances: BridgeReconciliationBalancesService) {}
	@Get() @Throttle({ default: { limit: 20, ttl: 60_000 } })
	async get(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
		response.setHeader('Cache-Control', 'no-store');
		return { data: await this.report.report(request.principal) };
	}
	@Get(':id/balances') @Throttle({ default: { limit: 4, ttl: 60_000 } })
	async check(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
		response.setHeader('Cache-Control', 'no-store');
		return { data: await this.balances.check(id, request.principal, response) };
	}
}
