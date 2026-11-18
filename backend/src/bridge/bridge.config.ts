import { LEARNING_BRIDGE_SOURCE_FT } from '../../../shared/src/config/learningBridge';
import { getAddress, isAddress } from 'viem';
import type { V15OperatorRoles } from '../../../shared/src/types/learningBridge';

function configuredAddress(name: 'V15_ADMIN_SIGNER_1' | 'V15_ADMIN_SIGNER_2' | 'V15_MINTER_ADDRESS') {
	const value = process.env[name] ?? '';
	if (!isAddress(value, { strict: true }) || /^0x0{40}$/i.test(value)) throw new Error(`${name} must be a nonzero checksummed EVM address.`);
	return getAddress(value);
}

export function v15OperatorRoles(): V15OperatorRoles {
	const signer1 = configuredAddress('V15_ADMIN_SIGNER_1');
	const signer2 = configuredAddress('V15_ADMIN_SIGNER_2');
	const minter = configuredAddress('V15_MINTER_ADDRESS');
	if (new Set([signer1.toLowerCase(), signer2.toLowerCase(), minter.toLowerCase()]).size !== 3) throw new Error('V1.5 Signer 1, Signer 2 and Minter must be three different addresses.');
	return { signer1, signer2, minter, threshold: 2 };
}

// Operator-approved first asset, selected by the user on 2026-10-28.
// Never derive these bindings from request metadata or a browser-selected RPC.
export const BRIDGE_ASSET_POLICY = Object.freeze({
	routeId: 'tbc-testnet-legacy-ft-to-hyperevm-testnet-v1',
	...LEARNING_BRIDGE_SOURCE_FT,
	sourceNetwork: 'testnet' as const,
	protocol: 'legacy-ft' as const,
	legacyVersion: 3,
	destinationChainId: 998 as const,
	minimumConfirmations: 6,
	// First stable checkpoint observed after the November 2026 Devnet reset.
	// Arbitrary operator-selected FT routes must prove their genesis on this
	// current chain rather than inheriting the retired MT checkpoint below.
	currentCheckpointHeight: 824600,
	currentCheckpointHash: '00000000768efe4716202c1b2c3ba3bf3250cd73d18d77f31e6e8e899deffdd8',
	// Public reference captured from the dedicated tbcdev API, not a client assertion.
	genesisBlockHeight: 838018,
	genesisBlockHash: '0000000000000368c3bf4aa8c04285cf69917a27c3fcf5d2c2fd24f8756c979c',
	mintSourceTxid: '0756eb73f180ce6abfeaf5f343ffcc63909f6fb4028f7a1e209a045890affdb2',
	mintSourceVout: 0,
	verificationMethod: 'tbc-contract-1.7.3-published-genesis-v1',
});
