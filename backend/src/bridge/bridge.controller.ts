import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { SessionGuard } from '../auth/session.guard';
import { bodyPipe } from '../auth/auth.controller';
import { VerifyBridgeAssetDto } from './bridge.dto';
import { BridgeService } from './bridge.service';

@ApiTags('Learning Bridge')
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller('api/bridge/assets')
export class BridgeController {
	constructor(@Inject(BridgeService) private readonly bridge: BridgeService) {}
	@Get(':contractId')
	async get(@Param('contractId') contractId: string, @Req() request: AuthenticatedRequest) {
		return { data: await this.bridge.get(contractId, request.principal) };
	}
	@Post('verify')
	@HttpCode(200)
	@Throttle({ default: { limit: 6, ttl: 60000 } })
	@ApiBody({ type: VerifyBridgeAssetDto })
	async verify(@Body(bodyPipe(VerifyBridgeAssetDto)) input: VerifyBridgeAssetDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
		return { data: await this.bridge.verify(input.contractId, request.principal, response) };
	}
}
