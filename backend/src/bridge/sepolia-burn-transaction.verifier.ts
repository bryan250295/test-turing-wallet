import { concatHex, decodeFunctionData, parseAbi, zeroHash, type Hex, type SignedAuthorization } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';

// MetaMask deploys these contracts deterministically on supported networks.
// Only this reviewed EIP-7702 path is accepted; arbitrary wrapper contracts are not.
export const METAMASK_DELEGATION_MANAGER = '0xdb9b1e94b5b69df7e401ddbede43491141047db3';
export const METAMASK_STATELESS_DELEGATOR = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';

const delegationAbi = parseAbi([
	'function redeemDelegations(bytes[] permissionContexts,bytes32[] modes,bytes[] executionCallDatas)',
]);

export interface FrozenBurnCall {
	chainId: number;
	fromAddress: string;
	toAddress: string;
	data: string;
	nonce: bigint;
}

export interface ObservedBurnTransaction {
	chainId?: number | null;
	from: string;
	to: string | null;
	input: string;
	value: bigint;
	nonce: number;
	type?: string;
	authorizationList?: readonly SignedAuthorization[];
}

/**
 * Accept either the exact direct call reviewed by the user or MetaMask's exact
 * EIP-7702 wrapper for that one call. Receipt/event verification remains a
 * separate mandatory step, so this only validates the transaction envelope.
 */
export async function matchesFrozenBurnEnvelope(tx: ObservedBurnTransaction, call: FrozenBurnCall) {
	if ((tx.chainId ?? 0) !== call.chainId || tx.from.toLowerCase() !== call.fromAddress.toLowerCase()
		|| tx.value !== 0n || tx.nonce !== Number(call.nonce)) return false;

	const direct = tx.to?.toLowerCase() === call.toAddress.toLowerCase()
		&& tx.input.toLowerCase() === call.data.toLowerCase();
	if (direct) return true;

	if (tx.type !== 'eip7702' || tx.to?.toLowerCase() !== METAMASK_DELEGATION_MANAGER
		|| tx.authorizationList?.length !== 1) return false;
	const authorization = tx.authorizationList[0];
	if (authorization.address.toLowerCase() !== METAMASK_STATELESS_DELEGATOR
		|| authorization.chainId !== call.chainId) return false;

	let signer: string;
	try { signer = await recoverAuthorizationAddress({ authorization }); }
	catch { return false; }
	if (signer.toLowerCase() !== call.fromAddress.toLowerCase()) return false;

	try {
		const decoded = decodeFunctionData({ abi: delegationAbi, data: tx.input as Hex });
		if (decoded.functionName !== 'redeemDelegations') return false;
		const [permissionContexts, modes, executionCallDatas] = decoded.args;
		const expectedExecution = concatHex([call.toAddress as Hex, zeroHash, call.data as Hex]);
		return permissionContexts.length === 1 && permissionContexts[0] !== '0x'
			&& modes.length === 1 && modes[0].toLowerCase() === zeroHash
			&& executionCallDatas.length === 1
			&& executionCallDatas[0].toLowerCase() === expectedExecution.toLowerCase();
	} catch { return false; }
}
