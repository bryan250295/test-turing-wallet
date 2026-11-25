import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsEthereumAddress, IsIn, IsString, Matches } from 'class-validator';
import type { Response } from 'express';
import { bodyPipe } from '../auth/auth.controller';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { SessionGuard } from '../auth/session.guard';
import { SepoliaBurnRedemptionService } from './sepolia-burn-redemption.service';

class PrepareSepoliaBurnDto {
	@ApiProperty({ type: String }) @IsEthereumAddress() holder!: string;
	@ApiProperty({ type: String }) @IsString() @Matches(/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/) tbcRecipient!: string;
}
class QuoteSepoliaBurnDto { @ApiProperty({ type: String }) @IsEthereumAddress() from!: string; }
class FundSepoliaFtReleaseDto { @ApiProperty({ type: String }) @Matches(/^(?!0{64}$)[0-9a-f]{64}$/) txid!: string; }
class SubmitSepoliaBurnDto { @ApiProperty({ type: String }) @Matches(/^0x(?!0{64}$)[0-9a-fA-F]{64}$/) txHash!: string; }
class CancelSepoliaBurnDto { @ApiProperty({ type: Boolean }) @IsBoolean() @IsIn([true]) notSent!: true; }
class BroadcastNativeReleaseDto {
	@ApiProperty({ type: String }) @Matches(/^[0-9a-f]{64}$/) planHash!: string;
	@ApiProperty({ type: Boolean }) @IsBoolean() @IsIn([true]) authorize!: true;
}

@ApiTags('Ethereum Sepolia burn return') @ApiCookieAuth() @UseGuards(SessionGuard)
@Controller('api/bridge/orders/:id/sepolia-redemption')
export class SepoliaBurnRedemptionController {
	constructor(@Inject(SepoliaBurnRedemptionService) private readonly service: SepoliaBurnRedemptionService) {}
	@Get() async get(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) { return { data: await this.service.get(id, request.principal) }; }
	@Post() @HttpCode(200) @Throttle({ default: { limit: 3, ttl: 60_000 } }) @ApiBody({ type: PrepareSepoliaBurnDto })
	async prepare(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(PrepareSepoliaBurnDto)) input: PrepareSepoliaBurnDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.prepare(id, input.holder, input.tbcRecipient, request.principal, response) }; }
	@Post('calls') @HttpCode(200) @Throttle({ default: { limit: 3, ttl: 60_000 } }) @ApiBody({ type: QuoteSepoliaBurnDto })
	async quote(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(QuoteSepoliaBurnDto)) input: QuoteSepoliaBurnDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.quote(id, input.from, request.principal, response) }; }
	@Post('funding') @HttpCode(200) @Throttle({ default: { limit: 6, ttl: 60_000 } }) @ApiBody({ type: FundSepoliaFtReleaseDto })
	async fund(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(FundSepoliaFtReleaseDto)) input: FundSepoliaFtReleaseDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.fund(id, input.txid, request.principal, response) }; }
	@Post('calls/:call/begin') @HttpCode(200)
	async begin(@Param('id', new ParseUUIDPipe()) id: string, @Param('call', new ParseUUIDPipe()) call: string, @Req() request: AuthenticatedRequest) { return { data: await this.service.begin(id, call, request.principal) }; }
	@Post('calls/:call/submit') @HttpCode(200) @ApiBody({ type: SubmitSepoliaBurnDto })
	async submit(@Param('id', new ParseUUIDPipe()) id: string, @Param('call', new ParseUUIDPipe()) call: string, @Body(bodyPipe(SubmitSepoliaBurnDto)) input: SubmitSepoliaBurnDto, @Req() request: AuthenticatedRequest) { return { data: await this.service.submit(id, call, input.txHash, request.principal) }; }
	@Post('calls/:call/cancel') @HttpCode(200) @ApiBody({ type: CancelSepoliaBurnDto })
	async cancel(@Param('id', new ParseUUIDPipe()) id: string, @Param('call', new ParseUUIDPipe()) call: string, @Body(bodyPipe(CancelSepoliaBurnDto)) input: CancelSepoliaBurnDto, @Req() request: AuthenticatedRequest) { return { data: await this.service.cancel(id, call, input.notSent, request.principal) }; }
	@Post('calls/:call/check') @HttpCode(200) @Throttle({ default: { limit: 8, ttl: 60_000 } })
	async checkBurn(@Param('id', new ParseUUIDPipe()) id: string, @Param('call', new ParseUUIDPipe()) call: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.checkBurn(id, call, request.principal, response) }; }
	@Post('release/broadcast') @HttpCode(200) @Throttle({ default: { limit: 2, ttl: 60_000 } }) @ApiBody({ type: BroadcastNativeReleaseDto })
	async broadcast(@Param('id', new ParseUUIDPipe()) id: string, @Body(bodyPipe(BroadcastNativeReleaseDto)) input: BroadcastNativeReleaseDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.broadcast(id, input.planHash, request.principal, response) }; }
	@Post('release/check') @HttpCode(200) @Throttle({ default: { limit: 8, ttl: 60_000 } })
	async checkRelease(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.service.checkRelease(id, request.principal, response) }; }
}
