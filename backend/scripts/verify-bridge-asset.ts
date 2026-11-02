import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { BridgeService } from '../src/bridge/bridge.service';

async function main() {
	const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
	try {
		const asset = await app.get(BridgeService).verifyConfiguredAsset();
		console.log(JSON.stringify({ event: 'bridge-asset-verified', ...asset }));
	} finally { await app.close(); }
}
void main().catch((cause: unknown) => {
	console.error(cause instanceof Error && ['UnprocessableEntityException', 'ConflictException', 'ServiceUnavailableException', 'GatewayTimeoutException'].includes(cause.name) ? cause.message : 'Could not register the bridge asset. Check migrations and backend availability.');
	process.exitCode = 1;
});
