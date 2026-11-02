import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsEthereumAddress, IsOptional, IsIn, IsString, IsUUID, MaxLength, Matches } from 'class-validator';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { SessionGuard } from '../auth/session.guard';
import { bodyPipe } from '../auth/auth.controller';
import { RedemptionWalletService } from './redemption-wallet.service';
import { RedemptionReleaseService } from './redemption-release.service';
import { BridgeRedemptionService } from './bridge-redemption.service';
import { RedemptionOrdersService } from './redemption-orders.service';
import { RedemptionEscrowService } from './redemption-escrow.service';

export class RedemptionWalletQuoteDto {
	@ApiProperty({ enum: ['unpause', 'reset', 'approve', 'lock'] }) @IsIn(['unpause', 'reset', 'approve', 'lock']) kind!: 'unpause' | 'reset' | 'approve' | 'lock';
	@ApiProperty({ type: String }) @IsEthereumAddress() from!: string;
}
export class ReleaseFundingDto {
	@ApiProperty({ type: String }) @Matches(/^[0-9a-f]{64}$/) txid!: string;
}
export class AuthorizeReleaseDto {
	@ApiProperty({ type: String }) @Matches(/^[0-9a-f]{64}$/) planHash!: string;
	@ApiProperty({ type: Boolean }) @IsIn([true]) authorize!: true;
}
export class PrepareRedemptionOrderDto {
	@ApiProperty({ type: String }) @IsUUID('4') escrowId!: string;
	@ApiProperty({ type: String }) @IsUUID('4') idempotencyKey!: string;
	@ApiProperty({ type: String }) @IsEthereumAddress() holder!: string;
	@ApiProperty({ type: String }) @IsString() @Matches(/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/) tbcRecipient!: string;
	@ApiProperty({ type: String }) @IsString() @MaxLength(278) @Matches(/^\d+(\.\d+)?$/) amount!: string;
}
export class PreviewRedemptionEscrowDto {
	@ApiProperty({ type: String, description: 'Existing wrapped-token admin; preview only, no deployment or approval.' })
	@IsEthereumAddress() from!: string;
}
export class SubmitEscrowDeploymentDto {
	@ApiProperty({ type: String }) @Matches(/^0x(?!0{64}$)[0-9a-f]{64}$/) txHash!: string;
}
export class CancelEscrowDeploymentDto {
	@ApiProperty({ type: Boolean, required: false, description: 'Only true after confirming no transaction was sent or a wallet request was rejected.' })
	@IsOptional() @IsBoolean() notSent?: boolean;
}

@ApiTags('Learning Bridge redemption') @ApiCookieAuth() @UseGuards(SessionGuard)
@Controller('api/bridge/orders/:id/redemption')
export class BridgeRedemptionController {
	constructor(@Inject(BridgeRedemptionService) private readonly service: BridgeRedemptionService, @Inject(RedemptionEscrowService) private readonly deployments: RedemptionEscrowService, @Inject(RedemptionOrdersService) private readonly redemptions: RedemptionOrdersService, @Inject(RedemptionReleaseService) private readonly releases: RedemptionReleaseService, @Inject(RedemptionWalletService) private readonly wallet: RedemptionWalletService) {}
	@Get('orders') async orders(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) { return { data: await this.redemptions.list(id, request.principal) }; }
	@Post('orders') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } }) @ApiBody({ type: PrepareRedemptionOrderDto })
	async prepareOrder(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(PrepareRedemptionOrderDto)) input: PrepareRedemptionOrderDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.redemptions.prepare(id, input, request.principal, response) }; }
	@Post('orders/:redemption/cancel') @HttpCode(200)
	async cancelOrder(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Req() request: AuthenticatedRequest) { return { data: await this.redemptions.cancel(id, redemption, request.principal) }; }
	@Get('orders/:redemption/wallet')
	async walletCalls(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Req() request: AuthenticatedRequest) { return { data: await this.wallet.list(id, redemption, request.principal) }; }
	@Post('orders/:redemption/wallet/state') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } })
	async walletState(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.wallet.state(id, redemption, request.principal, response) }; }
	@Post('orders/:redemption/wallet/quote') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } }) @ApiBody({ type: RedemptionWalletQuoteDto })
	async walletQuote(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Body(bodyPipe(RedemptionWalletQuoteDto)) input: RedemptionWalletQuoteDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.wallet.quote(id, redemption, input.kind, input.from, request.principal, response) }; }
	@Post('orders/:redemption/wallet/:call/begin') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } })
	async walletBegin(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Param('call', new ParseUUIDPipe()) call: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.wallet.begin(id, redemption, call, request.principal, response) }; }
	@Post('orders/:redemption/wallet/:call/submit') @HttpCode(200) @ApiBody({ type: SubmitEscrowDeploymentDto })
	async walletSubmit(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Param('call', new ParseUUIDPipe()) call: string, @Body(bodyPipe(SubmitEscrowDeploymentDto)) input: SubmitEscrowDeploymentDto, @Req() request: AuthenticatedRequest) { return { data: await this.wallet.submit(id, redemption, call, input.txHash, request.principal) }; }
	@Post('orders/:redemption/wallet/:call/cancel') @HttpCode(200) @ApiBody({ type: CancelEscrowDeploymentDto })
	async walletCancel(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Param('call', new ParseUUIDPipe()) call: string, @Body(bodyPipe(CancelEscrowDeploymentDto)) input: CancelEscrowDeploymentDto, @Req() request: AuthenticatedRequest) { return { data: await this.wallet.cancel(id, redemption, call, input.notSent === true, request.principal) }; }
	@Post('orders/:redemption/wallet/:call/check') @HttpCode(200) @Throttle({ default: { limit: 8, ttl: 60_000 } })
	async walletCheck(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Param('call', new ParseUUIDPipe()) call: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.wallet.check(id, redemption, call, request.principal, response) }; }
	@Get('orders/:redemption/release')
	async release(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Req() request: AuthenticatedRequest) { return { data: await this.releases.get(id, redemption, request.principal) }; }
	@Post('orders/:redemption/release/open') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } })
	async openRelease(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.releases.open(id, redemption, request.principal, response) }; }
	@Post('orders/:redemption/release/funding') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } }) @ApiBody({ type: ReleaseFundingDto })
	async funding(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Body(bodyPipe(ReleaseFundingDto)) input: ReleaseFundingDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.releases.fund(id, redemption, input.txid, request.principal, response) }; }
	@Post('orders/:redemption/release/lock') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } }) @ApiBody({ type: SubmitEscrowDeploymentDto })
	async lock(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Body(bodyPipe(SubmitEscrowDeploymentDto)) input: SubmitEscrowDeploymentDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.releases.attachLock(id, redemption, input.txHash, request.principal, response) }; }
	@Post('orders/:redemption/release/sign') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } }) @ApiBody({ type: AuthorizeReleaseDto })
	async signRelease(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Body(bodyPipe(AuthorizeReleaseDto)) input: AuthorizeReleaseDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.releases.sign(id, redemption, input.planHash, request.principal, response) }; }
	@Post('orders/:redemption/release/broadcast') @HttpCode(200) @Throttle({ default: { limit: 3, ttl: 60_000 } }) @ApiBody({ type: AuthorizeReleaseDto })
	async broadcastRelease(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Body(bodyPipe(AuthorizeReleaseDto)) input: AuthorizeReleaseDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.releases.broadcast(id, redemption, input.planHash, request.principal, response) }; }
	@Post('orders/:redemption/release/check') @HttpCode(200) @Throttle({ default: { limit: 6, ttl: 60_000 } })
	async checkRelease(@Param('id', new ParseUUIDPipe()) id: string, @Param('redemption', new ParseUUIDPipe()) redemption: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.releases.check(id, redemption, request.principal, response) }; }
	@Post('preview') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } }) @ApiBody({ type: PreviewRedemptionEscrowDto })
	async preview(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(PreviewRedemptionEscrowDto)) input: PreviewRedemptionEscrowDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
		return { data: await this.service.preview(id, input.from, request.principal, response) };
	}
	@Get('deployments') async list(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) { return { data: await this.deployments.list(id, request.principal) }; }
	@Post('deployments') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } }) @ApiBody({ type: PreviewRedemptionEscrowDto })
	async prepare(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(PreviewRedemptionEscrowDto)) input: PreviewRedemptionEscrowDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.deployments.prepare(id, input.from, request.principal, response) }; }
	@Post('deployments/:deployment/begin') @HttpCode(200) @Throttle({ default: { limit: 4, ttl: 60_000 } })
	async begin(@Param('id', new ParseUUIDPipe()) id: string, @Param('deployment', new ParseUUIDPipe()) deployment: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.deployments.begin(id, deployment, request.principal, response) }; }
	@Post('deployments/:deployment/submit') @HttpCode(200) @ApiBody({ type: SubmitEscrowDeploymentDto })
	async submit(@Param('id', new ParseUUIDPipe()) id: string, @Param('deployment', new ParseUUIDPipe()) deployment: string, @Body(bodyPipe(SubmitEscrowDeploymentDto)) input: SubmitEscrowDeploymentDto, @Req() request: AuthenticatedRequest) { return { data: await this.deployments.submit(id, deployment, input.txHash, request.principal) }; }
	@Post('deployments/:deployment/cancel') @HttpCode(200) @ApiBody({ type: CancelEscrowDeploymentDto })
	async cancel(@Param('id', new ParseUUIDPipe()) id: string, @Param('deployment', new ParseUUIDPipe()) deployment: string, @Body(bodyPipe(CancelEscrowDeploymentDto)) input: CancelEscrowDeploymentDto, @Req() request: AuthenticatedRequest) { return { data: await this.deployments.cancel(id, deployment, input.notSent === true, request.principal) }; }
	@Post('deployments/:deployment/check') @HttpCode(200) @Throttle({ default: { limit: 8, ttl: 60_000 } })
	async check(@Param('id', new ParseUUIDPipe()) id: string, @Param('deployment', new ParseUUIDPipe()) deployment: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.deployments.check(id, deployment, request.principal, response) }; }
}
