import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
	schema: 'prisma/schema.prisma',
	migrations: { path: 'prisma/migrations' },
	// Generation runs while building an image without deployment credentials.
	// The fallback is never used by application code, which validates DATABASE_URL.
	datasource: { url: process.env.DATABASE_URL ?? 'postgresql://build:build@127.0.0.1:5432/build' },
});
