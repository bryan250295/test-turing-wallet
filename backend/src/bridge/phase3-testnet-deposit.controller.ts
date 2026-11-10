import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { bodyPipe } from '../auth/auth.controller';
import { SessionGuard } from '../auth/session.guard';
import {
	BroadcastPhase3TestnetDepositDto, BuildPhase3TestnetDepositDto,
	FinalizePhase3TestnetDepositDto, Phase3TestnetDepositBuildDto,
} from './bridge.dto';
import { Phase3TestnetDepositService } from './phase3-testnet-deposit.service';

@ApiTags('Proof-backed Testnet v3 deposit') @ApiCookieAuth() @UseGuards(SessionGuard)
@Controller('api/bridge/phase3/testnet-deposit')
export class Phase3TestnetDepositController {
	constructor(@Inject(Phase3TestnetDepositService) private readonly deposits: Phase3TestnetDepositService) {}
	@Post('build') @HttpCode(200) @Throttle({ default: { limit: 3, ttl: 60_000 } }) @ApiBody({ type: BuildPhase3TestnetDepositDto })
	build(@Body(bodyPipe(BuildPhase3TestnetDepositDto)) body: BuildPhase3TestnetDepositDto, @Req() request: AuthenticatedRequest) { return this.deposits.build(request.principal, { ...body, recipient: body.recipient as `0x${string}` }).then((data) => ({ data })); }
	@Post('signing-request') @HttpCode(200) @ApiBody({ type: Phase3TestnetDepositBuildDto })
	signing(@Body(bodyPipe(Phase3TestnetDepositBuildDto)) body: Phase3TestnetDepositBuildDto, @Req() request: AuthenticatedRequest) { return this.deposits.signing(request.principal, body.buildId).then((data) => ({ data })); }
	@Post('finalize') @HttpCode(200) @ApiBody({ type: FinalizePhase3TestnetDepositDto })
	finalize(@Body(bodyPipe(FinalizePhase3TestnetDepositDto)) body: FinalizePhase3TestnetDepositDto, @Req() request: AuthenticatedRequest) { return this.deposits.finalize(request.principal, body.buildId, body.publicKey, body.signatures).then((data) => ({ data })); }
	@Post('broadcast') @HttpCode(200) @ApiBody({ type: BroadcastPhase3TestnetDepositDto })
	broadcast(@Body(bodyPipe(BroadcastPhase3TestnetDepositDto)) body: BroadcastPhase3TestnetDepositDto, @Req() request: AuthenticatedRequest) { return this.deposits.broadcast(request.principal, body.buildId, body.action === 'check').then((data) => ({ data })); }
}
