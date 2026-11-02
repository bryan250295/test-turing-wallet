import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Equals, IsBoolean, IsEthereumAddress, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import type { Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { bodyPipe } from '../auth/auth.controller';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { BridgeSourcePaymentService } from './bridge-source-payment.service';
import { BridgeSettlementService } from './bridge-settlement.service';

export class OpenBridgePaymentDto {
	@ApiProperty({ type: Boolean, description: 'Explicit acknowledgement of custodial payment, exact source token amount and no automatic refund.' })
	@Equals(true) acknowledged!: true;
}
export class CheckBridgeDepositDto {
	@ApiProperty({ type: String, required: false }) @IsOptional() @Matches(/^(?!0{64}$)[0-9a-f]{64}$/) txid?: string;
}
export class SubmitSourcePaymentDto {
	@ApiProperty({ type: String }) @IsUUID('4') attemptId!: string;
	@ApiProperty({ type: String }) @Matches(/^(?!0{64}$)[0-9a-f]{64}$/) txid!: string;
}
export class CancelSourcePaymentDto {
	@ApiProperty({ type: String }) @IsUUID('4') attemptId!: string;
	@ApiProperty({ type: Boolean }) @Equals(true) notSent!: true;
}
export class QuoteBridgeCallDto {
	@ApiProperty({ enum: ['unpause', 'mint', 'next'] }) @IsIn(['unpause', 'mint', 'next']) kind!: 'unpause' | 'mint' | 'next';
	@ApiProperty({ type: String }) @IsEthereumAddress() from!: string;
}
export class SubmitBridgeCallDto {
	@ApiProperty({ type: String }) @Matches(/^0x(?!0{64}$)[0-9a-f]{64}$/) txHash!: string;
}
export class CancelBridgeCallDto {
	@ApiProperty({ type: Boolean, required: false }) @IsOptional() @IsBoolean() rejected?: boolean;
}

@ApiTags('Learning Bridge settlement') @ApiCookieAuth() @UseGuards(SessionGuard)
@Controller('api/bridge/orders/:id/settlement')
@Throttle({ default: { limit: 12, ttl: 60_000 } })
export class BridgeSettlementController {
	constructor(@Inject(BridgeSettlementService) private readonly service: BridgeSettlementService, @Inject(BridgeSourcePaymentService) private readonly sourcePayment: BridgeSourcePaymentService) {}
	@Get() async get(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) { return { data: await this.service.get(id, request.principal) }; }
	@Get('payment')
	async payment(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) { return { data: await this.sourcePayment.get(id, request.principal) }; }
	@Post('payment/begin') @HttpCode(200) @ApiBody({ type: OpenBridgePaymentDto })
	async beginPayment(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(OpenBridgePaymentDto)) _input: OpenBridgePaymentDto, @Req() request: AuthenticatedRequest) { return { data: await this.sourcePayment.change(id, request.principal, 'begin') }; }
	@Post('payment/submit') @HttpCode(200) @ApiBody({ type: SubmitSourcePaymentDto })
	async submitPayment(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(SubmitSourcePaymentDto)) input: SubmitSourcePaymentDto, @Req() request: AuthenticatedRequest) { return { data: await this.sourcePayment.change(id, request.principal, 'submit', input.attemptId, input.txid) }; }
	@Post('payment/cancel') @HttpCode(200) @ApiBody({ type: CancelSourcePaymentDto })
	async cancelPayment(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(CancelSourcePaymentDto)) input: CancelSourcePaymentDto, @Req() request: AuthenticatedRequest) { return { data: await this.sourcePayment.change(id, request.principal, 'cancel', input.attemptId) }; }
	@Post('open') @HttpCode(200) @ApiBody({ type: OpenBridgePaymentDto })
	async open(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(OpenBridgePaymentDto)) _input: OpenBridgePaymentDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.open(id, request.principal, response) }; }
	@Post('deposit') @HttpCode(200) @ApiBody({ type: CheckBridgeDepositDto })
	async deposit(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(CheckBridgeDepositDto)) input: CheckBridgeDepositDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.deposit(id, input.txid, request.principal, response) }; }
	@Post('calls') @HttpCode(200) @ApiBody({ type: QuoteBridgeCallDto })
	async quote(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(QuoteBridgeCallDto)) input: QuoteBridgeCallDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.quote(id, input.kind, input.from, request.principal, response) }; }
	@Post('calls/:attemptId/begin') @HttpCode(200)
	async begin(@Param('id', new ParseUUIDPipe()) id: string, @Param('attemptId', new ParseUUIDPipe()) attempt: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.begin(id, attempt, request.principal, response) }; }
	@Post('calls/:attemptId/submit') @HttpCode(200) @ApiBody({ type: SubmitBridgeCallDto })
	async submit(@Param('id', new ParseUUIDPipe()) id: string, @Param('attemptId', new ParseUUIDPipe()) attempt: string, @Body(bodyPipe(SubmitBridgeCallDto)) input: SubmitBridgeCallDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.submit(id, attempt, input.txHash, request.principal, response) }; }
	@Post('calls/:attemptId/check') @HttpCode(200)
	async check(@Param('id', new ParseUUIDPipe()) id: string, @Param('attemptId', new ParseUUIDPipe()) attempt: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.check(id, attempt, request.principal, response) }; }
	@Post('calls/:attemptId/cancel') @HttpCode(200) @ApiBody({ type: CancelBridgeCallDto })
	async cancel(@Param('id', new ParseUUIDPipe()) id: string, @Param('attemptId', new ParseUUIDPipe()) attempt: string, @Body(bodyPipe(CancelBridgeCallDto)) input: CancelBridgeCallDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.cancel(id, attempt, input.rejected === true, request.principal, response) }; }
}
