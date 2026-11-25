import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbi, stringToHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { TBC_ETHEREUM_BURN_WRAPPED_ASSET_BUILD as build } from '../../shared/src/contracts/tbcEthereumBurnWrappedAsset';
import { ETHEREUM_BRIDGE_ADMIN_MULTISIG_BUILD as adminBuild } from '../../shared/src/contracts/ethereumBridgeAdminMultisig';

const port = 18546;
const rpcUrl = `http://127.0.0.1:${port}`;
const chain = { id: 11155111, name: 'Local Ethereum Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
const mnemonic = 'test test test test test test test test test test test junk';
const deployer = mnemonicToAccount(mnemonic, { addressIndex: 0 });
const signer1 = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const signer2 = mnemonicToAccount(mnemonic, { addressIndex: 2 });
const minter = mnemonicToAccount(mnemonic, { addressIndex: 3 });
const holder = mnemonicToAccount(mnemonic, { addressIndex: 4 });
const outsider = mnemonicToAccount(mnemonic, { addressIndex: 5 });
const abi = parseAbi([
	'function paused() view returns (bool)',
	'function minter() view returns (address)',
	'function sourceAssetId() view returns (bytes32)',
	'function sourceAssetKind() view returns (uint8)',
	'function sourceDecimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)',
	'function balanceOf(address) view returns (uint256)',
	'function processedOrders(bytes32) view returns (bool)',
	'function processedRedemptions(bytes32) view returns (bool)',
	'function unpause()',
	'function pause()',
	'function mintFromDeposit(bytes32,bytes32,uint8,bytes32,uint32,address,uint256)',
	'function burnForRedemption(bytes32,string,uint256)',
]);
const adminAbi = parseAbi([
	'function nonce() view returns (uint256)',
	'function threshold() view returns (uint256)',
	'function signer1() view returns (address)',
	'function signer2() view returns (address)',
	'function propose(address,bytes) returns (bytes32)',
	'function approveAndExecute(bytes32) returns (bytes)',
]);

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const wallet = (account: typeof deployer) => createWalletClient({ account, chain, transport: http(rpcUrl) });

async function waitForRpc() {
	for (let attempt = 0; attempt < 80; attempt++) {
		try { if (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }).then(r => r.ok)) return; }
		catch { /* node is starting */ }
		await new Promise(resolveWait => setTimeout(resolveWait, 100));
	}
	throw new Error('Local Sepolia test node did not start.');
}

async function main() {
	const hardhat = resolve(process.cwd(), 'phase3-hardhat/node_modules/.bin/hardhat');
	const config = resolve(process.cwd(), 'phase3-hardhat/sepolia.config.ts');
	const node = spawn(hardhat, ['node', '--config', config, '--hostname', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
	let nodeError = '';
	node.stderr.on('data', chunk => { nodeError += String(chunk); });
	try {
		await waitForRpc();
		const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
		const sourceAssetId = keccak256(stringToHex('tbc/testnet/native-tbc'));
		const adminDeploymentHash = await wallet(deployer).deployContract({ abi: adminBuild.abi, bytecode: adminBuild.bytecode, args: [signer1.address, signer2.address] });
		const adminDeployment = await publicClient.waitForTransactionReceipt({ hash: adminDeploymentHash });
		assert(adminDeployment.status === 'success' && adminDeployment.contractAddress, 'Sepolia admin multisig deployment failed.');
		const adminAddress = adminDeployment.contractAddress;
		const adminBinding = await Promise.all([
			publicClient.readContract({ address: adminAddress, abi: adminAbi, functionName: 'threshold' }),
			publicClient.readContract({ address: adminAddress, abi: adminAbi, functionName: 'signer1' }),
			publicClient.readContract({ address: adminAddress, abi: adminAbi, functionName: 'signer2' }),
		]);
		assert(adminBinding[0] === 2n && adminBinding[1] === signer1.address && adminBinding[2] === signer2.address, 'Sepolia admin must be the configured 2-of-2 multisig.');
		const deploymentHash = await wallet(deployer).deployContract({ abi: build.abi, bytecode: build.bytecode, args: [
			adminAddress, minter.address, sourceAssetId, 6, 0, 'Wrapped TBC', 'wTBC',
		] });
		const deployment = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
		assert(deployment.status === 'success' && deployment.contractAddress, 'Burn bridge deployment failed.');
		const address = deployment.contractAddress;
		const binding = await Promise.all([
			publicClient.readContract({ address, abi, functionName: 'paused' }),
			publicClient.readContract({ address, abi, functionName: 'minter' }),
			publicClient.readContract({ address, abi, functionName: 'sourceAssetId' }),
			publicClient.readContract({ address, abi, functionName: 'sourceAssetKind' }),
			publicClient.readContract({ address, abi, functionName: 'sourceDecimals' }),
		]);
		assert(binding[0] === true && binding[1] === minter.address && binding[2] === sourceAssetId && binding[3] === 0 && binding[4] === 6, 'Native TBC deployment binding is wrong.');
		const unpauseData = encodeFunctionData({ abi, functionName: 'unpause' });
		const actionId = keccak256(encodeAbiParameters(
			[{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
			[11155111n, adminAddress, 0n, address, keccak256(unpauseData)],
		));
		const proposeHash = await wallet(signer1).writeContract({ address: adminAddress, abi: adminAbi, functionName: 'propose', args: [address, unpauseData] });
		assert((await publicClient.waitForTransactionReceipt({ hash: proposeHash })).status === 'success', 'Signer 1 could not propose route activation.');
		const duplicateApprovalHash = await wallet(signer1).writeContract({ address: adminAddress, abi: adminAbi, functionName: 'approveAndExecute', args: [actionId], gas: 500_000n });
		assert((await publicClient.waitForTransactionReceipt({ hash: duplicateApprovalHash })).status === 'reverted', 'Signer 1 executed its own proposal without signer 2.');
		const outsiderProposalHash = await wallet(outsider).writeContract({ address: adminAddress, abi: adminAbi, functionName: 'propose', args: [address, unpauseData], gas: 500_000n });
		assert((await publicClient.waitForTransactionReceipt({ hash: outsiderProposalHash })).status === 'reverted', 'A non-signer proposed an admin action.');
		const unpauseHash = await wallet(signer2).writeContract({ address: adminAddress, abi: adminAbi, functionName: 'approveAndExecute', args: [actionId] });
		assert((await publicClient.waitForTransactionReceipt({ hash: unpauseHash })).status === 'success', 'Signer 2 could not execute route activation.');

		const orderId = keccak256(stringToHex('order-1'));
		const sourceTxid = keccak256(stringToHex('source-transaction-1'));
		const rejectedMint = await wallet(outsider).writeContract({ address, abi, functionName: 'mintFromDeposit', args: [orderId, sourceAssetId, 0, sourceTxid, 0, holder.address, 1_500_000n], gas: 500_000n });
		assert((await publicClient.waitForTransactionReceipt({ hash: rejectedMint })).status === 'reverted', 'A non-minter minted wrapped TBC.');
		const mintHash = await wallet(minter).writeContract({ address, abi, functionName: 'mintFromDeposit', args: [orderId, sourceAssetId, 0, sourceTxid, 0, holder.address, 1_500_000n] });
		assert((await publicClient.waitForTransactionReceipt({ hash: mintHash })).status === 'success', 'Verified native TBC mint failed.');
		assert(await publicClient.readContract({ address, abi, functionName: 'totalSupply' }) === 1_500_000n, 'Minted supply is wrong.');
		const replayMint = await wallet(minter).writeContract({ address, abi, functionName: 'mintFromDeposit', args: [orderId, sourceAssetId, 0, sourceTxid, 0, holder.address, 1_500_000n], gas: 500_000n });
		assert((await publicClient.waitForTransactionReceipt({ hash: replayMint })).status === 'reverted', 'A source deposit was minted twice.');

		const redemptionId = keccak256(stringToHex('redemption-1'));
		const burnHash = await wallet(holder).writeContract({ address, abi, functionName: 'burnForRedemption', args: [redemptionId, '1BwTB5gPYQ7KGmDeX2huVc2oCEBKKZBqa5', 1_500_000n] });
		assert((await publicClient.waitForTransactionReceipt({ hash: burnHash })).status === 'success', 'Wrapped TBC burn failed.');
		const [supply, balance, burned] = await Promise.all([
			publicClient.readContract({ address, abi, functionName: 'totalSupply' }),
			publicClient.readContract({ address, abi, functionName: 'balanceOf', args: [holder.address] }),
			publicClient.readContract({ address, abi, functionName: 'processedRedemptions', args: [redemptionId] }),
		]);
		assert(supply === 0n && balance === 0n && burned === true, 'Burn did not destroy supply or save replay protection.');
		const replayBurn = await wallet(holder).writeContract({ address, abi, functionName: 'burnForRedemption', args: [redemptionId, '1BwTB5gPYQ7KGmDeX2huVc2oCEBKKZBqa5', 1n], gas: 500_000n });
		assert((await publicClient.waitForTransactionReceipt({ hash: replayBurn })).status === 'reverted', 'A redemption ID was burned twice.');

		// The same reviewed bytecode must bind a TBC FT route independently: the
		// source ID is the TT genesis TXID, source kind is 1 and decimals remain 2.
		const ttSourceAssetId = '0x52b6a3d05583042d0aff73aed30c7630a11eda291f90e1aff52a9a4173c26ebb' as const;
		const ttDeploymentHash = await wallet(deployer).deployContract({ abi: build.abi, bytecode: build.bytecode, args: [
			adminAddress, minter.address, ttSourceAssetId, 2, 1, 'Wrapped Turing Token', 'wTT',
		] });
		const ttDeployment = await publicClient.waitForTransactionReceipt({ hash: ttDeploymentHash });
		assert(ttDeployment.status === 'success' && ttDeployment.contractAddress, 'wTT burn bridge deployment failed.');
		const ttAddress = ttDeployment.contractAddress;
		const ttBinding = await Promise.all([
			publicClient.readContract({ address: ttAddress, abi, functionName: 'paused' }),
			publicClient.readContract({ address: ttAddress, abi, functionName: 'sourceAssetId' }),
			publicClient.readContract({ address: ttAddress, abi, functionName: 'sourceAssetKind' }),
			publicClient.readContract({ address: ttAddress, abi, functionName: 'sourceDecimals' }),
		]);
		assert(ttBinding[0] === true && ttBinding[1] === ttSourceAssetId && ttBinding[2] === 1 && ttBinding[3] === 2, 'TT deployment binding is wrong.');
		const ttActionId = keccak256(encodeAbiParameters(
			[{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
			[11155111n, adminAddress, 1n, ttAddress, keccak256(unpauseData)],
		));
		assert((await publicClient.waitForTransactionReceipt({ hash: await wallet(signer1).writeContract({ address: adminAddress, abi: adminAbi, functionName: 'propose', args: [ttAddress, unpauseData] }) })).status === 'success', 'Signer 1 could not propose wTT activation.');
		assert((await publicClient.waitForTransactionReceipt({ hash: await wallet(signer2).writeContract({ address: adminAddress, abi: adminAbi, functionName: 'approveAndExecute', args: [ttActionId] }) })).status === 'success', 'Signer 2 could not activate wTT.');
		const ttOrderId = keccak256(stringToHex('tt-order-1')); const ttTxid = keccak256(stringToHex('tt-source-transaction-1'));
		assert((await publicClient.waitForTransactionReceipt({ hash: await wallet(minter).writeContract({ address: ttAddress, abi, functionName: 'mintFromDeposit', args: [ttOrderId, ttSourceAssetId, 1, ttTxid, 0, holder.address, 12_345n] }) })).status === 'success', 'Verified TT mint failed.');
		const ttRedemptionId = keccak256(stringToHex('tt-redemption-1'));
		assert((await publicClient.waitForTransactionReceipt({ hash: await wallet(holder).writeContract({ address: ttAddress, abi, functionName: 'burnForRedemption', args: [ttRedemptionId, '1BwTB5gPYQ7KGmDeX2huVc2oCEBKKZBqa5', 12_345n] }) })).status === 'success', 'wTT burn failed.');
		assert(await publicClient.readContract({ address: ttAddress, abi, functionName: 'totalSupply' }) === 0n, 'wTT burn did not reduce supply to zero.');
		console.log(`Ethereum burn bridge local test passed at ${address} and ${ttAddress}: native TBC and TT bindings, 2-of-2 activation, limited mint, burn, and replay protection verified.`);
	} finally {
		node.kill('SIGTERM');
		await new Promise<void>(resolveExit => { node.once('exit', () => resolveExit()); setTimeout(() => resolveExit(), 2_000); });
		if (node.exitCode && node.exitCode !== 0) throw new Error(`Local node failed: ${nodeError.trim()}`);
	}
}

void main().catch(cause => { console.error(cause); process.exitCode = 1; });
