import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { SessionGuard } from '../auth/session.guard';
import { bodyPipe } from '../auth/auth.controller';
import { RegisterEthereumSepoliaFtRouteDto } from './bridge.dto';
import { EthereumSepoliaRouteService } from './ethereum-sepolia-route.service';

@ApiTags('Ethereum Sepolia burn bridge')
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller('api/bridge/ethereum-sepolia')
export class EthereumSepoliaRouteController {
	constructor(@Inject(EthereumSepoliaRouteService) private readonly routes: EthereumSepoliaRouteService) {}
	@Get('route')
	async route(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
		return { data: await this.routes.ensure(request.principal, response) };
	}
	@Post('route/ft')
	@HttpCode(200)
	@ApiBody({ type: RegisterEthereumSepoliaFtRouteDto })
	async registerFt(@Body(bodyPipe(RegisterEthereumSepoliaFtRouteDto)) input: RegisterEthereumSepoliaFtRouteDto, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
		return { data: await this.routes.registerFt(input, request.principal, response) };
	}
}
