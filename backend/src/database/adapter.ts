import { PrismaPg } from '@prisma/adapter-pg';

export function databaseAdapter() {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString?.startsWith('postgresql://')) throw new Error('DATABASE_URL must be configured.');
	return new PrismaPg({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
}
