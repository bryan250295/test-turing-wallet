import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SessionGuard } from '../auth/session.guard';
import type { AuthenticatedRequest } from '../auth/auth.service';
import { ActionLogDto } from '../auth/auth.dto';
import { bodyPipe } from '../auth/auth.controller';

@Controller('__wallet-log') @UseGuards(SessionGuard)
export class ActionLogController {
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
	@Post() @HttpCode(204)
	async record(@Body(bodyPipe(ActionLogDto)) input: ActionLogDto, @Req() request: AuthenticatedRequest) {
		// Only allowlisted summary fields are accepted; arbitrary wallet responses are never logged.
		await this.db.auditEvent.create({ data: { identityId: request.principal.id, action: input.action, data: { outcome: input.outcome } } });
	}
}
