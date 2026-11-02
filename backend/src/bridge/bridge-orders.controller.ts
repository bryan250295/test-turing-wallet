import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { SessionGuard } from '../auth/session.guard';
import { bodyPipe } from '../auth/auth.controller';
import { BridgeOrdersService } from './bridge-orders.service';
import { PrepareBridgeOrderDto } from './bridge.dto';

@ApiTags('Learning Bridge') @ApiCookieAuth() @UseGuards(SessionGuard)
@Controller('api/bridge/orders')
export class BridgeOrdersController {
	constructor(@Inject(BridgeOrdersService) private readonly orders: BridgeOrdersService) {}
	@Get('setup') async setup(@Req() request: AuthenticatedRequest) { return { data: await this.orders.setup(request.principal) }; }
	@Get() async list(@Req() request: AuthenticatedRequest) { return { data: await this.orders.list(request.principal) }; }
	@Post() @HttpCode(200) @Throttle({ default: { limit: 6, ttl: 60_000 } }) @ApiBody({ type: PrepareBridgeOrderDto })
	async prepare(@Body(bodyPipe(PrepareBridgeOrderDto)) input: PrepareBridgeOrderDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) { return { data: await this.orders.prepare(input, request.principal, response) }; }
	@Post(':id/cancel') @HttpCode(200)
	async cancel(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) { return { data: await this.orders.cancel(id, request.principal) }; }
}
