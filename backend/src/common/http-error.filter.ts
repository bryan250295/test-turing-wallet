import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
	private readonly logger = new Logger('HTTP');
	catch(error: unknown, host: ArgumentsHost) {
		const request = host.switchToHttp().getRequest<Request & { requestId?: string }>();
		const response = host.switchToHttp().getResponse<Response>();
		const parserStatus = error && typeof error === 'object' && 'type' in error && ['entity.too.large', 'entity.parse.failed'].includes(String(error.type)) ? String(error.type) === 'entity.too.large' ? 413 : 400 : undefined;
		const status = error instanceof HttpException ? error.getStatus() : parserStatus ?? 500;
		const detail = error instanceof HttpException ? error.getResponse() : null;
		const message = typeof detail === 'string' ? detail : detail && typeof detail === 'object' && 'message' in detail ? detail.message : parserStatus ? 'The request body is invalid or too large.' : 'The backend could not complete this request. Check its availability and retry safely.';
		// Deliberately exclude stack, request body, query string, cookies and signatures.
		if (status >= 500) this.logger.error(JSON.stringify({ requestId: request.requestId, method: request.method, path: request.path, status, errorType: error instanceof Error ? error.name : 'Unknown' }));
		if (status === 429) response.setHeader('Retry-After', '5');
		if (!response.headersSent && !response.destroyed) response.status(status).json({ message, code: `HTTP_${status}`, requestId: request.requestId });
	}
}
