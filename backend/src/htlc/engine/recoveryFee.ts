import tbc from 'tbc-lib-js';

// Assembly-only placeholders: no key is used to sign, and these scripts are
// never returned or broadcast. Leave room for uncompressed wallet public keys.
export const sizingPublicKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
export const sizingSignatures = Array(3).fill(`3046022100${'80'.repeat(32)}022100${'80'.repeat(32)}41`) as string[];

export function reserveRecoveryFee(raw: string, nativeInput: bigint, fillForSizing: (raw: string) => string): string {
	let result = raw;
	for (let attempt = 0; attempt < 3; attempt++) {
		const tx = new tbc.Transaction(result);
		const allocated = nativeInput - tx.outputs.reduce((sum, output) => sum + BigInt(output.satoshis), 0n);
		const estimatedBytes = fillForSizing(result).length / 2 + 128;
		const target = BigInt(Math.max(80, Math.ceil(estimatedBytes / 1000 * 80)));
		if (allocated >= target) return result;
		const change = tx.outputs[2];
		const extra = target - allocated;
		if (!change || BigInt(change.satoshis) <= extra) throw new Error('The native fee input cannot fund the recovery proof scripts. Add more native test TBC to the signing account.');
		tx.setOutput(2, new tbc.Transaction.Output({ script: change.script, satoshis: Number(BigInt(change.satoshis) - extra) }));
		result = tx.uncheckedSerialize();
	}
	throw new Error('Could not establish a stable recovery fee. Nothing was signed or submitted.');
}
