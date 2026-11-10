import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConsoleLogger, Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { environment } from './config/environment';
import { HttpErrorFilter } from './common/http-error.filter';
import { AuthService } from './auth/auth.service';
import { TransactionHistoryService } from './transaction-history/transaction-history.service';
import { attachTransactionHistoryWebSocket } from './transaction-history/transaction-history.websocket';
import { ProofBridgeV3ProgressService } from './bridge/proof-bridge-v3-progress.service';
import { attachProofBridgeV3WebSocket } from './bridge/proof-bridge-v3.websocket';

async function bootstrap() {
	const config = environment();
	const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: new ConsoleLogger({ json: true }) });
	app.use(helmet());
	app.use(cookieParser());
	app.use((req: import('express').Request & { requestId?: string }, res: import('express').Response, next: import('express').NextFunction) => {
		req.requestId = randomUUID();
		const startedAt = Date.now();
		res.once('finish', () => Logger.log({ requestId: req.requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt }, 'HTTP'));
		res.setHeader('X-Request-Id', req.requestId);
		res.setHeader('Cache-Control', 'no-store');
		const origin = req.get('Origin');
		if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin !== config.origin || origin && origin !== config.origin || req.get('Sec-Fetch-Site') === 'cross-site') {
			res.status(403).json({ message: 'Use the configured application origin.', code: 'ORIGIN_DENIED', requestId: req.requestId }); return;
		}
		next();
	});
	app.useBodyParser('json', { limit: '16kb', strict: true });
	app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
	app.useGlobalFilters(new HttpErrorFilter());
	app.enableShutdownHooks();
	// Same-origin Vite/Nginx proxy; no permissive cross-origin credential access.
	if (process.env.NODE_ENV !== 'production') {
		const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Learning Bridge API').setVersion('1').addCookieAuth('bridge_session').build());
		SwaggerModule.setup('api/docs', app, document, { swaggerOptions: { persistAuthorization: false } });
	}
	attachTransactionHistoryWebSocket(app.getHttpServer(), app.get(AuthService), app.get(TransactionHistoryService), config.origin);
	attachProofBridgeV3WebSocket(app.getHttpServer(), app.get(AuthService), app.get(ProofBridgeV3ProgressService), config.origin);
	await app.listen(config.port, '0.0.0.0');
	Logger.log(`Backend ready on port ${config.port}`, 'Bootstrap');
}
void bootstrap().catch(() => { Logger.error('Backend startup failed. Check database connectivity, configuration and encryption key availability.', undefined, 'Bootstrap'); process.exitCode = 1; });
