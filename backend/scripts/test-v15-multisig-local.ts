import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, parseAbi } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { BRIDGE_ADMIN_MULTISIG_BUILD as build } from '../../shared/src/contracts/bridgeAdminMultisig';

const rpcUrl = process.env.V15_LOCAL_RPC_URL ?? 'http://127.0.0.1:18545';
const chain = { id: 998, name: 'Local HyperEVM Testnet', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
const mnemonic = 'test test test test test test test test test test test junk';
const deployer = mnemonicToAccount(mnemonic, { addressIndex: 0 });
const signer1 = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const signer2 = mnemonicToAccount(mnemonic, { addressIndex: 2 });
const outsider = mnemonicToAccount(mnemonic, { addressIndex: 3 });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = (account: typeof deployer) => createWalletClient({ account, chain, transport: http(rpcUrl) });
const abi = parseAbi([
	'function propose(address target, bytes data) returns (bytes32 actionId)',
	'function approveAndExecute(bytes32 actionId) returns (bytes returnData)',
	'function action(bytes32 actionId) view returns (address target, bytes data, bool executed)',
	'function signer1() view returns (address)', 'function signer2() view returns (address)', 'function threshold() view returns (uint256)',
]);

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function main() {
	const deploymentHash = await wallet(deployer).deployContract({ abi: build.abi, bytecode: build.bytecode, args: [signer1.address, signer2.address] });
	const deployment = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
	assert(deployment.status === 'success' && deployment.contractAddress, 'Multisig deployment failed.');
	const address = deployment.contractAddress;
	const configured = await Promise.all([
		publicClient.readContract({ address, abi, functionName: 'signer1' }),
		publicClient.readContract({ address, abi, functionName: 'signer2' }),
		publicClient.readContract({ address, abi, functionName: 'threshold' }),
	]);
	assert(configured[0] === signer1.address && configured[1] === signer2.address && configured[2] === 2n, 'Deployed signer configuration is wrong.');

	const data = '0x12345678';
	const rejectedHash = await wallet(outsider).writeContract({ address, abi, functionName: 'propose', args: [deployer.address, data], gas: 500_000n });
	assert((await publicClient.waitForTransactionReceipt({ hash: rejectedHash })).status === 'reverted', 'An outsider was able to propose an action.');

	const actionId = keccak256(encodeAbiParameters(
		[{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
		[998n, address, 0n, deployer.address, keccak256(data)],
	));
	const proposeHash = await wallet(signer1).writeContract({ address, abi, functionName: 'propose', args: [deployer.address, data], gas: 500_000n });
	assert((await publicClient.waitForTransactionReceipt({ hash: proposeHash })).status === 'success', 'Signer 1 proposal failed.');
	const duplicateHash = await wallet(signer1).writeContract({ address, abi, functionName: 'approveAndExecute', args: [actionId], gas: 500_000n });
	assert((await publicClient.waitForTransactionReceipt({ hash: duplicateHash })).status === 'reverted', 'Signer 1 supplied both approvals.');
	const executeHash = await wallet(signer2).writeContract({ address, abi, functionName: 'approveAndExecute', args: [actionId], gas: 500_000n });
	assert((await publicClient.waitForTransactionReceipt({ hash: executeHash })).status === 'success', 'Signer 2 execution failed.');
	const action = await publicClient.readContract({ address, abi, functionName: 'action', args: [actionId] });
	assert(action[0] === deployer.address && action[1] === data && action[2] === true, 'Executed action state is incorrect.');
	console.log(`V1.5 multisig local test passed at ${address}: outsider rejected, duplicate approval rejected, 2-of-2 execution succeeded.`);
}

void main().catch((cause) => { console.error(cause); process.exitCode = 1; });
