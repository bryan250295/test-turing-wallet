import { buildTbcInclusionProof } from '../src/bridge/phase1/tbc-proof.builder';
import { OfficialTbcApiProofSource, TbcScanProofSource } from '../src/bridge/phase1/tbc-proof.sources';
import type { TbcNetwork, TbcProofDataSource } from '../src/bridge/phase1/tbc-proof.types';

interface Arguments { txid: string; vout: number; network: TbcNetwork; provider: 'auto' | 'tbcscan' | 'official' }

function usage(): never {
	throw new Error('Usage: npm run phase1:proof -- --txid <64-hex> [--vout 0] [--network testnet] [--provider auto|tbcscan|official]');
}

function argumentsFrom(values: string[]): Arguments {
	const options = new Map<string, string>();
	for (let index = 0; index < values.length; index += 2) {
		const name = values[index]; const value = values[index + 1];
		if (!name?.startsWith('--') || value === undefined) usage();
		options.set(name.slice(2), value);
	}
	const txid = options.get('txid');
	const network = options.get('network') ?? 'testnet';
	const provider = options.get('provider') ?? 'auto';
	const voutText = options.get('vout') ?? '0';
	if (!txid || !/^[0-9a-f]{64}$/i.test(txid) || network !== 'testnet'
		|| !['auto', 'tbcscan', 'official'].includes(provider) || !/^\d+$/.test(voutText)) usage();
	const vout = Number(voutText);
	if (!Number.isSafeInteger(vout) || vout > 0xffffffff) usage();
	return { txid: txid.toLowerCase(), vout, network: network as TbcNetwork, provider: provider as Arguments['provider'] };
}

async function main() {
	const input = argumentsFrom(process.argv.slice(2));
	const candidates: TbcProofDataSource[] = input.provider === 'tbcscan' ? [new TbcScanProofSource()]
		: input.provider === 'official' ? [new OfficialTbcApiProofSource()]
			: [new TbcScanProofSource(), new OfficialTbcApiProofSource()];
	const failures: string[] = [];
	for (const source of candidates) {
		try {
			const proof = await buildTbcInclusionProof(source, input.txid, input.vout);
			process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
			return;
		} catch (cause) {
			failures.push(`${source.id}: ${cause instanceof Error ? cause.message : 'unknown failure'}`);
		}
	}
	throw new Error(`No provider produced a self-consistent proof. ${failures.join(' | ')}`);
}

void main().catch((cause: unknown) => {
	console.error(cause instanceof Error ? cause.message : 'Phase 1 proof construction failed.');
	process.exitCode = 1;
});
