import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService, type AuthenticatedRequest } from './auth.service';
import { LoginChallengeDto, VerifyLoginDto } from './auth.dto';
import { SessionGuard } from './session.guard';

export const bodyPipe = (expectedType: new () => object) => new ValidationPipe({ expectedType, whitelist: true, forbidNonWhitelisted: true, transform: true });

@ApiTags('Authentication')
@Controller('api/auth')
export class AuthController {
	constructor(@Inject(AuthService) private readonly auth: AuthService) {}
	@Get('session')
	async session(@Req() request: Request) {
		const current = await this.auth.session(request);
		return { data: current ? { identity: { id: current.id, chain: current.chain, network: current.network, address: current.address, role: current.role }, csrfToken: current.csrfToken, expiresAt: current.expiresAt.toISOString() } : null };
	}
	@Post('challenge') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60000 } })
	@ApiBody({ type: LoginChallengeDto })
	async challenge(@Body(bodyPipe(LoginChallengeDto)) input: LoginChallengeDto, @Res({ passthrough: true }) response: Response) {
		return { data: await this.auth.challenge(input, response) };
	}
	@Post('verify') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60000 } })
	@ApiBody({ type: VerifyLoginDto })
	async verify(@Body(bodyPipe(VerifyLoginDto)) input: VerifyLoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
		return { data: await this.auth.login(input.challengeId, input.signature, request, response) };
	}
	@Post('logout') @HttpCode(200) @UseGuards(SessionGuard) @ApiCookieAuth()
	async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
		return { data: await this.auth.logout(request.principal, response) };
	}
}
