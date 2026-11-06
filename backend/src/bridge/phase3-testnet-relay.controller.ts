import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService, type AuthenticatedRequest } from '../auth/auth.service';
import { bodyPipe } from '../auth/auth.controller';
import { SessionGuard } from '../auth/session.guard';
import { PreparePhase3TestnetRelayDto } from './bridge.dto';
import { Phase3TestnetRelayService } from './phase3-testnet-relay.service';

@ApiTags('Proof-backed Testnet v2')
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller('api/bridge/phase3/testnet-relay')
export class Phase3TestnetRelayController {
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(Phase3TestnetRelayService) private readonly relay: Phase3TestnetRelayService,
	) {}

	@Post('plan')
	@HttpCode(200)
	@Throttle({ default: { limit: 3, ttl: 60000 } })
	@ApiBody({ type: PreparePhase3TestnetRelayDto })
	async plan(
		@Body(bodyPipe(PreparePhase3TestnetRelayDto)) input: PreparePhase3TestnetRelayDto,
		@Req() request: AuthenticatedRequest,
	) {
		this.auth.requireTbc(request.principal);
		return { data: await this.relay.prepare(input.from) };
	}
}
