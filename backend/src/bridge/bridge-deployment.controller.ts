import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { bodyPipe } from '../auth/auth.controller';
import { SessionGuard } from '../auth/session.guard';
import { CheckV15ActivationDto, CheckV15MultisigDto, PreviewBridgeDeploymentDto, PreviewV15ActivationDto, PreviewV15MultisigDto, SubmitBridgeDeploymentDto } from './bridge.dto';
import { BridgeDeploymentService } from './bridge-deployment.service';
import { BridgeDeploymentLifecycleService } from './bridge-deployment-lifecycle.service';
import { BridgeV15MultisigService } from './bridge-v15-multisig.service';

@ApiTags('Learning Bridge')
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller('api/bridge/deployments')
export class BridgeDeploymentController {
	constructor(
		@Inject(BridgeDeploymentService) private readonly deployment: BridgeDeploymentService,
		@Inject(BridgeDeploymentLifecycleService) private readonly lifecycle: BridgeDeploymentLifecycleService,
		@Inject(BridgeV15MultisigService) private readonly multisig: BridgeV15MultisigService,
	) {}
	@Get('v15/roles')
	async v15Roles(@Req() request: AuthenticatedRequest) { return { data: this.multisig.roles(request.principal) }; }
	@Post('v15/multisig/preview') @HttpCode(200) @Throttle({ default: { limit: 6, ttl: 60_000 } }) @ApiBody({ type: PreviewV15MultisigDto })
	async previewV15Multisig(@Body(bodyPipe(PreviewV15MultisigDto)) input: PreviewV15MultisigDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.multisig.preview(input.deployer, request.principal, response) }; }
	@Post('v15/multisig/check') @HttpCode(200) @Throttle({ default: { limit: 30, ttl: 60_000 } }) @ApiBody({ type: CheckV15MultisigDto })
	async checkV15Multisig(@Body(bodyPipe(CheckV15MultisigDto)) input: CheckV15MultisigDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.multisig.check(input.txHash as `0x${string}`, request.principal, response) }; }
	@Get(':id/v15/activation') @Throttle({ default: { limit: 30, ttl: 60_000 } })
	async v15Activation(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.multisig.activationState(id, request.principal, response) }; }
	@Post(':id/v15/activation/preview') @HttpCode(200) @Throttle({ default: { limit: 12, ttl: 60_000 } }) @ApiBody({ type: PreviewV15ActivationDto })
	async previewV15Activation(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(PreviewV15ActivationDto)) input: PreviewV15ActivationDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.multisig.previewActivation(id, input.kind, input.actionId as `0x${string}` | undefined, request.principal, response) }; }
	@Post(':id/v15/activation/check') @HttpCode(200) @Throttle({ default: { limit: 30, ttl: 60_000 } }) @ApiBody({ type: CheckV15ActivationDto })
	async checkV15Activation(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(CheckV15ActivationDto)) input: CheckV15ActivationDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.multisig.checkActivation(id, input.kind, input.actionId as `0x${string}`, input.txHash as `0x${string}`, request.principal, response) }; }
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
