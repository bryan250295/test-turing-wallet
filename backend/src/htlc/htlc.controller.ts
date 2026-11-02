import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { SessionGuard } from '../auth/session.guard';
import { bodyPipe } from '../auth/auth.controller';
import { SecretChallengeDto, SecretVerifyDto } from '../auth/auth.dto';
import { API_URLS } from '../../../shared/src/config/constants';
import { BroadcastDto, BuildIdDto, FinalizeDto, InspectDto, LockTermsDto, SettleDto, WalletStatusDto } from './htlc.dto';
import { HtlcService } from './htlc.service';

@ApiTags('HTLC') @ApiCookieAuth() @UseGuards(SessionGuard)
@Controller('__htlc')
export class HtlcController {
	constructor(@Inject(HtlcService) private readonly htlc: HtlcService) {}
	@Get('locks')
	async list(@Query('address') address: string, @Req() request: AuthenticatedRequest) { return { data: await this.htlc.list(address, request.principal) }; }
	@Get('locks/:lockTxid')
	async get(@Param('lockTxid') lockTxid: string, @Req() request: AuthenticatedRequest) {
		const record = await this.htlc.get(lockTxid.toLowerCase(), request.principal);
		if (!record) throw new NotFoundException('No saved record exists for this lock.');
		return { data: record };
	}
	@Post('locks') @HttpCode(200)
	async save(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.htlc.importBrowserRecord(body, request.principal, response) }; }
	@Post('locks/status') @HttpCode(200)
	@ApiBody({ type: WalletStatusDto })
	async status(@Body(bodyPipe(WalletStatusDto)) body: WalletStatusDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.htlc.execute(API_URLS.htlcWalletStatus, body, request.principal, response) }; }
	@Post('token/unsigned') @HttpCode(200)
	@ApiBody({ type: LockTermsDto })
	async build(@Body(bodyPipe(LockTermsDto)) body: LockTermsDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.htlc.execute(API_URLS.unsignedTokenHtlc, body, request.principal, response) }; }
	@Post('token/signing-request') @HttpCode(200)
	@ApiBody({ type: BuildIdDto })
	async signing(@Body(bodyPipe(BuildIdDto)) body: BuildIdDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.htlc.execute(API_URLS.tokenHtlcSigningRequest, body, request.principal, response) }; }
	@Post('token/finalize') @HttpCode(200)
	@ApiBody({ type: FinalizeDto })
	async finalize(@Body(bodyPipe(FinalizeDto)) body: FinalizeDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.htlc.execute(API_URLS.finalizeTokenHtlc, body, request.principal, response) }; }
	@Post('token/broadcast') @HttpCode(200)
	@ApiBody({ type: BroadcastDto })
	async broadcast(@Body(bodyPipe(BroadcastDto)) body: BroadcastDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.htlc.execute(API_URLS.broadcastTokenHtlc, body, request.principal, response) }; }
	@Post('token/inspect') @HttpCode(200)
	@ApiBody({ type: InspectDto })
	async inspect(@Body(bodyPipe(InspectDto)) body: InspectDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.htlc.execute(API_URLS.inspectTokenHtlc, body, request.principal, response) }; }
	@Post('token/settle') @HttpCode(200)
	@ApiBody({ type: SettleDto })
	async settle(@Body(bodyPipe(SettleDto)) body: SettleDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.htlc.execute(API_URLS.settleTokenHtlc, body, request.principal, response) }; }
	@Post('secret/challenge') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60000 } })
	@ApiBody({ type: SecretChallengeDto })
	async challenge(@Body(bodyPipe(SecretChallengeDto)) body: SecretChallengeDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.htlc.secretChallenge(body.lockTxid, request.principal, response) }; }
	@Post('secret/retrieve') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60000 } })
	@ApiBody({ type: SecretVerifyDto })
	async retrieve(@Body(bodyPipe(SecretVerifyDto)) body: SecretVerifyDto, @Req() request: AuthenticatedRequest) { return { data: await this.htlc.reveal(body.challengeId, body.signature, request.principal) }; }
}
