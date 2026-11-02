import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { bodyPipe } from '../auth/auth.controller';
import { SessionGuard } from '../auth/session.guard';
import { PreviewBridgeDeploymentDto, SubmitBridgeDeploymentDto } from './bridge.dto';
import { BridgeDeploymentService } from './bridge-deployment.service';
import { BridgeDeploymentLifecycleService } from './bridge-deployment-lifecycle.service';

@ApiTags('Learning Bridge')
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller('api/bridge/deployments')
export class BridgeDeploymentController {
	constructor(
		@Inject(BridgeDeploymentService) private readonly deployment: BridgeDeploymentService,
		@Inject(BridgeDeploymentLifecycleService) private readonly lifecycle: BridgeDeploymentLifecycleService,
	) {}
	@Get()
	async list(@Req() request: AuthenticatedRequest, @Query('contractId') contractId?: string) { return { data: await this.lifecycle.list(request.principal, contractId) }; }
	@Post('preview')
	@HttpCode(200)
	@Throttle({ default: { limit: 6, ttl: 60_000 } })
	@ApiBody({ type: PreviewBridgeDeploymentDto })
	async preview(@Body(bodyPipe(PreviewBridgeDeploymentDto)) input: PreviewBridgeDeploymentDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
		return { data: await this.deployment.preview(input, request.principal, response) };
	}
	@Post('prepare') @HttpCode(200) @Throttle({ default: { limit: 6, ttl: 60_000 } }) @ApiBody({ type: PreviewBridgeDeploymentDto })
	async prepare(@Body(bodyPipe(PreviewBridgeDeploymentDto)) input: PreviewBridgeDeploymentDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
		return { data: await this.lifecycle.prepare(input, request.principal, response) };
	}
	@Post(':id/begin') @HttpCode(200) @Throttle({ default: { limit: 6, ttl: 60_000 } })
	async begin(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.lifecycle.begin(id, request.principal, response) }; }
	@Post(':id/cancel') @HttpCode(200)
	async cancel(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) { return { data: await this.lifecycle.cancel(id, request.principal) }; }
	@Post(':id/submit') @HttpCode(200) @ApiBody({ type: SubmitBridgeDeploymentDto })
	async submit(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(SubmitBridgeDeploymentDto)) input: SubmitBridgeDeploymentDto, @Req() request: AuthenticatedRequest) { return { data: await this.lifecycle.submit(id, input.txHash, request.principal) }; }
	@Post(':id/check') @HttpCode(200) @Throttle({ default: { limit: 30, ttl: 60_000 } })
	async check(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.lifecycle.check(id, request.principal, response) }; }
}
