import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTbcInclusionProof } from './tbc-proof.builder';
import { OfficialTbcApiProofSource, TbcScanProofSource } from './tbc-proof.sources';

test('parses the documented official block schema and hexadecimal compact bits', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({
		code: '200', message: 'OK', data: {
			bits: '1d00efff',
			hash: '0000000058968601042df9b0d57e41b092c76d6f91f333dc231cdd4cc4fd861d',
			height: 824190,
			merkleroot: '666a860f2af836985ea01ef20dbe7d0f012e6a399eaf2b8c997497c35c701f06',
			nonce: 563364325,
			previoushash: '000000008cbb162a198ea6d21c2bff298d5cfed1f93454f616fa43a36290d710',
			time: 1708354684,
			tx: ['666a860f2af836985ea01ef20dbe7d0f012e6a399eaf2b8c997497c35c701f06'],
			txcnt: 1,
			version: 536870912,
		},
	}), { status: 200, headers: { 'content-type': 'application/json' } });
	try {
		const block = await new OfficialTbcApiProofSource().readBlock(824190);
		assert.equal(block.bits, 0x1d00efff);
		assert.equal(block.previousBlockHash, '000000008cbb162a198ea6d21c2bff298d5cfed1f93454f616fa43a36290d710');
		assert.equal(block.transactionCount, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('builds through the TBCScan endpoint schema and accepts binary raw bytes', async () => {
	const txid = '05d4aa0cea6dd08ed9723f685120b7389a42963760498897e30e12a0cd2e77b7';
	const raw = '0a00000000010000000000000000016a00000000';
	const hash = '9b8fe080a39f86719b2ac7f685524a56eb8385ab410959b151d78addc53831bf';
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
		if (url.pathname.endsWith('/status')) return Response.json({ status: 'confirmed', block_height: 7, block_time: 1792473237, confirmations: 5 });
		if (url.pathname.endsWith('/raw')) return new Response(Buffer.from(raw, 'hex'), { headers: { 'content-type': 'application/octet-stream' } });
		if (url.pathname.endsWith('/txs')) return Response.json([{ txid }]);
		return Response.json({
			id: hash, height: 7, version: 559636480, previous_hash: '0'.repeat(64),
			merkle_root: txid, timestamp: 1792473237, bits: 0x2100ffff, nonce: 563364325, tx_count: 1,
		});
	};
	try {
		const proof = await buildTbcInclusionProof(new TbcScanProofSource(), txid, 0, { powLimit: (1n << 256n) - 1n });
		assert.equal(proof.proofMaterial.rawTransaction, raw);
		assert.equal(proof.proofMaterial.blockHash, hash);
		assert.equal(proof.observation.confirmations, 5);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
