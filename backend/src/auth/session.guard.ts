import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { AuthService, type AuthenticatedRequest } from './auth.service';

@Injectable()
export class SessionGuard implements CanActivate {
	constructor(@Inject(AuthService) private readonly auth: AuthService) {}
	async canActivate(context: ExecutionContext) {
		const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
		const session = await this.auth.session(request);
		if (!session) throw new UnauthorizedException('Sign in with your wallet to use the backend.');
		if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
			const token = request.get('X-CSRF-Token') ?? '';
			if (!/^[0-9a-f]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrfToken))) throw new ForbiddenException('Refresh your login session before continuing.');
		}
		request.principal = session;
		return true;
	}
}
