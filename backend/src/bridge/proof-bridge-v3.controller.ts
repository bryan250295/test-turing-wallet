import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService, type AuthenticatedRequest } from '../auth/auth.service';
import { bodyPipe } from '../auth/auth.controller';
import { SessionGuard } from '../auth/session.guard';
import { RegisterPhase3TestnetV3RouteDto } from './bridge.dto';
import { ProofBridgeV3RouteService } from './proof-bridge-v3-route.service';
import { ProofBridgeV3ProgressService } from './proof-bridge-v3-progress.service';
import { ProofBridgeV3GasPreflightService } from './proof-bridge-v3-gas-preflight.service';

@ApiTags('Proof-backed Testnet v3') @ApiCookieAuth() @UseGuards(SessionGuard)
@Controller('api/bridge/phase3/testnet-v3')
export class ProofBridgeV3Controller {
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(ProofBridgeV3RouteService) private readonly routes: ProofBridgeV3RouteService,
		@Inject(ProofBridgeV3ProgressService) private readonly progress: ProofBridgeV3ProgressService,
		@Inject(ProofBridgeV3GasPreflightService) private readonly gasPreflight: ProofBridgeV3GasPreflightService,
	) {}

	@Get('progress')
	async current(@Req() request: AuthenticatedRequest) {
		this.auth.requireTbc(request.principal);
		return { data: await this.progress.snapshot(request.principal.id) };
	}

	@Get('preflight') @Throttle({ default: { limit: 20, ttl: 60_000 } })
	async preflight(@Req() request: AuthenticatedRequest) {
		this.auth.requireTbc(request.principal);
		return { data: await this.gasPreflight.check() };
	}

	@Post('route') @HttpCode(200) @Throttle({ default: { limit: 3, ttl: 60_000 } })
	@ApiBody({ type: RegisterPhase3TestnetV3RouteDto })
	async register(@Body(bodyPipe(RegisterPhase3TestnetV3RouteDto)) body: RegisterPhase3TestnetV3RouteDto, @Req() request: AuthenticatedRequest) {
		this.auth.requireTbc(request.principal);
		const data = await this.routes.register(request.principal, body);
		await this.progress.publish(request.principal.id);
		return { data };
	}
}
