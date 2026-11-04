import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters,
	encodeDeployData, encodeFunctionData, getContractAddress, http, keccak256,
	toHex, type Abi, type Address, type Hex,
} from 'viem';
import { blockWork } from '../src/bridge/phase1/tbc-consensus';
import { serializeBlockHeader } from '../src/bridge/phase1/tbc-proof.crypto';
import {
	buildTbcdevBootstrapCommitment, decodeTbcdevBootstrapContext, tbcdevBootstrapProof,
} from '../src/bridge/phase3/bootstrap-history';
import {
	PHASE3D_GATEWAY, RELAY_HEADERS, phase3dEnvelopeVector,
} from './test-phase3-solidity';

const CHAIN_ID = 998;
const RESERVE_CONTROLLER = `0x${'22'.repeat(20)}` as Hex;

interface Artifact {
	abi: Abi;
	bytecode: Hex;
	deployedBytecode: Hex;
	compilerVersion: string;
	buildInputSha256: string;
}

interface BootstrapManifest {
	binaryFile: string;
	commitmentRoot: Hex;
}

interface JsonRpcResponse<T = unknown> {
	result?: T;
	error?: { code: number; message: string; data?: unknown };
}

function localChain(rpcUrl: string) {
	return {
		id: CHAIN_ID,
		name: 'Phase 3E local HyperEVM-compatible chain',
		nativeCurrency: { name: 'Local HYPE', symbol: 'HYPE', decimals: 18 },
		rpcUrls: { default: { http: [rpcUrl] } },
		testnet: true,
	} as const;
}

async function reservePort() {
	const server = createServer();
	await new Promise<void>((resolvePromise, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolvePromise());
	});
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const { port } = address;
	await new Promise<void>((resolvePromise, reject) => {
		server.close((error) => error ? reject(error) : resolvePromise());
	});
	return port;
}

async function jsonRpc<T>(rpcUrl: string, method: string, params: unknown[] = []) {
	const response = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (!response.ok) throw new Error(`Local EVM returned HTTP ${response.status}.`);
	const body = await response.json() as JsonRpcResponse<T>;
	if (body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
	return body.result as T;
}

async function waitForLocalEvm(
	rpcUrl: string,
	node: { exitCode: number | null },
	output: () => string,
) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (node.exitCode !== null) throw new Error(`Hardhat exited early.\n${output()}`);
		try {
			const chainId = await jsonRpc<string>(rpcUrl, 'eth_chainId');
			assert.equal(Number(BigInt(chainId)), CHAIN_ID);
			return;
		} catch {
			await delay(100);
		}
	}
	throw new Error(`Timed out waiting for local EVM.\n${output()}`);
}

async function expectCallRevert(call: () => Promise<unknown>, label: string) {
	await assert.rejects(call, `${label} unexpectedly succeeded.`);
}

async function main() {
	const port = await reservePort();
	const rpcUrl = `http://127.0.0.1:${port}`;
	const hardhatExecutable = resolve(
		process.cwd(), 'phase3-hardhat/node_modules/.bin/hardhat',
	);
	const hardhatConfig = resolve(process.cwd(), 'phase3-hardhat/hardhat.config.ts');
	let nodeOutput = '';
	const node = spawn(hardhatExecutable, [
		'node', '--config', hardhatConfig, '--hostname', '127.0.0.1', '--port', String(port),
	], {
		cwd: process.cwd(),
		env: { ...process.env, FORCE_COLOR: '0' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const rememberOutput = (value: Buffer) => {
		nodeOutput = `${nodeOutput}${value.toString()}`.slice(-20_000);
	};
	node.stdout.on('data', rememberOutput);
	node.stderr.on('data', rememberOutput);

	try {
		await waitForLocalEvm(rpcUrl, node, () => nodeOutput);
		const chain = localChain(rpcUrl);
		const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
		const walletClient = createWalletClient({ chain, transport: http(rpcUrl) });
		const accounts = await walletClient.getAddresses();
		assert.ok(accounts.length >= 2, 'The local EVM did not expose two funded test accounts.');
		const [deployer, proofSubmitter] = accounts;
		const startingNonce = await publicClient.getTransactionCount({ address: deployer });
		const predictedGateway = getContractAddress({
			from: deployer,
			nonce: BigInt(startingNonce) + 2n,
		});
		assert.notEqual(predictedGateway.toLowerCase(), PHASE3D_GATEWAY.toLowerCase());

		const artifactRoot = resolve(process.cwd(), '../wallet/artifacts/phase3');
		const loadArtifact = async (name: string) => JSON.parse(await readFile(
			resolve(artifactRoot, `${name}.json`), 'utf8',
		)) as Artifact;
		const [authorizationArtifact, prefixArtifact, gatewayArtifact, relayArtifact,
			tokenArtifact] = await Promise.all([
			loadArtifact('TbcAuthorizedTransitionVerifier'),
			loadArtifact('TbcFtUnlockPrefixVerifierModule'),
			loadArtifact('TbcProofMintGateway'),
			loadArtifact('TbcHeaderRelayV2'),
			loadArtifact('WrappedFTV2'),
		]);

		const deploy = async (artifact: Artifact, args: readonly unknown[] = []) => {
			const hash = await walletClient.deployContract({
				account: deployer,
				abi: artifact.abi,
				bytecode: artifact.bytecode,
				args,
				gas: 8_000_000n,
			});
			const receipt = await publicClient.waitForTransactionReceipt({ hash });
			assert.equal(receipt.status, 'success', `Deployment ${hash} reverted.`);
			assert.ok(receipt.contractAddress);
			return { address: receipt.contractAddress, gasUsed: receipt.gasUsed };
		};
		const authorization = await deploy(authorizationArtifact);
		const prefix = await deploy(prefixArtifact);
		const gateway = await deploy(gatewayArtifact, [
			authorization.address, prefix.address, RESERVE_CONTROLLER,
		]);
		assert.equal(gateway.address.toLowerCase(), predictedGateway.toLowerCase());

		const [relay, token, configuredAuthorization, configuredPrefix, configuredReserve] =
			await Promise.all([
				publicClient.readContract({
					address: gateway.address, abi: gatewayArtifact.abi, functionName: 'relay',
				}) as Promise<Address>,
				publicClient.readContract({
					address: gateway.address, abi: gatewayArtifact.abi, functionName: 'wrappedToken',
				}) as Promise<Address>,
				publicClient.readContract({
					address: gateway.address, abi: gatewayArtifact.abi,
					functionName: 'authorizationVerifier',
				}) as Promise<Address>,
				publicClient.readContract({
					address: gateway.address, abi: gatewayArtifact.abi, functionName: 'prefixVerifier',
				}) as Promise<Address>,
				publicClient.readContract({
					address: gateway.address, abi: gatewayArtifact.abi, functionName: 'reserveController',
				}) as Promise<Hex>,
			]);
		assert.equal(configuredAuthorization.toLowerCase(), authorization.address.toLowerCase());
		assert.equal(configuredPrefix.toLowerCase(), prefix.address.toLowerCase());
		assert.equal(configuredReserve.toLowerCase(), RESERVE_CONTROLLER.toLowerCase());
		assert.equal(await publicClient.getCode({ address: relay }), relayArtifact.deployedBytecode);
		const tokenRuntime = await publicClient.getCode({ address: token });
		assert.ok(tokenRuntime && tokenRuntime !== '0x', 'Token runtime must exist.');
		assert.equal(tokenRuntime.length, tokenArtifact.deployedBytecode.length);
		const tokenGateway = await publicClient.readContract({
			address: token, abi: tokenArtifact.abi, functionName: 'gateway',
		}) as Address;
		assert.equal(tokenGateway.toLowerCase(), gateway.address.toLowerCase());

		const fixtureRoot = resolve(process.cwd(), 'src/bridge/phase3/fixtures');
		const manifest = JSON.parse(await readFile(
			resolve(fixtureRoot, 'tbcdev-bootstrap-history-v1.json'), 'utf8',
		)) as BootstrapManifest;
		const bootstrapPoints = decodeTbcdevBootstrapContext(await readFile(
			resolve(fixtureRoot, manifest.binaryFile),
		));
		const commitment = buildTbcdevBootstrapCommitment(bootstrapPoints);
		assert.equal(commitment.root, manifest.commitmentRoot);
		const bootstrapByHeight = new Map(bootstrapPoints.map((point, index) => [point.height, index]));
		const solidityPoint = (index: number) => ({
			height: bootstrapPoints[index].height,
			blockHash: `0x${bootstrapPoints[index].blockHash}` as Hex,
			time: bootstrapPoints[index].time,
			bits: bootstrapPoints[index].bits,
			chainWork: bootstrapPoints[index].chainWork,
		});
		const relayWitnesses = RELAY_HEADERS.map((header) => {
			const previousHeight = header.height - 1;
			const heights = [
				previousHeight - 8_064,
				previousHeight - 146, previousHeight - 145, previousHeight - 144,
				...Array.from({ length: 23 }, (_, index) => previousHeight - 22 + index),
			].filter((height) => height < 839_164);
			return heights.map((height) => {
				const pointIndex = bootstrapByHeight.get(height);
				assert.notEqual(pointIndex, undefined, `Missing bootstrap point ${height}.`);
				return {
					point: solidityPoint(pointIndex!),
					siblings: tbcdevBootstrapProof(commitment, height),
				};
			});
		});

		const headerGas: bigint[] = [];
		for (const [index, header] of RELAY_HEADERS.entries()) {
			const hash = await walletClient.writeContract({
				account: proofSubmitter,
				address: relay,
				abi: relayArtifact.abi,
				functionName: 'submitHeader',
				args: [
					`0x${serializeBlockHeader(header).toString('hex')}`,
					relayWitnesses[index],
				],
				gas: 2_000_000n,
			});
			const receipt = await publicClient.waitForTransactionReceipt({ hash });
			assert.equal(receipt.status, 'success', `Header ${header.height} reverted.`);
			headerGas.push(receipt.gasUsed);
		}
		const depositBlockHash = `0x${RELAY_HEADERS[0].hash}` as Hex;
		assert.equal(await publicClient.readContract({
			address: relay,
			abi: relayArtifact.abi,
			functionName: 'isFinalized',
			args: [depositBlockHash],
		}), true);
		const expectedWork = RELAY_HEADERS.reduce(
			(total, header) => total + blockWork(header.bits),
			bootstrapPoints.at(-1)!.chainWork,
		);
		assert.equal(await publicClient.readContract({
			address: relay, abi: relayArtifact.abi, functionName: 'bestChainWork',
		}), expectedWork);

		const depositVector = phase3dEnvelopeVector(gateway.address);
		const headerBase = BigInt(keccak256(encodeAbiParameters(
			[{ type: 'bytes32' }, { type: 'uint256' }], [depositBlockHash, 0n],
		)));
		const merkleRootSlot = toHex(headerBase + 1n, { size: 32 });
		await jsonRpc(rpcUrl, 'hardhat_setStorageAt', [
			relay, merkleRootSlot, depositVector.txid,
		]);
		await jsonRpc(rpcUrl, 'evm_mine');
		const storedHeader = await publicClient.readContract({
			address: relay,
			abi: relayArtifact.abi,
			functionName: 'header',
			args: [depositBlockHash],
		}) as { merkleRoot: Hex };
		assert.equal(storedHeader.merkleRoot, depositVector.txid);

		const proof = {
			blockHash: depositBlockHash,
			rawTransaction: depositVector.raw,
			transactionIndex: 0,
			transactionCount: 1,
			displayedSiblings: [] as Hex[],
			parentTransactions: depositVector.parents,
			ancestorTransactions: depositVector.ancestors,
			signatureWitnesses: depositVector.signatureWitnesses,
			signaturePushOffsets: depositVector.signaturePushOffsets,
		};
		const mintData = encodeFunctionData({
			abi: gatewayArtifact.abi,
			functionName: 'mintFromProof',
			args: [proof],
		});
		const mintHash = await walletClient.sendTransaction({
			account: proofSubmitter,
			to: gateway.address,
			data: mintData,
			gas: 3_500_000n,
		});
		const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
		assert.equal(mintReceipt.status, 'success');
		const decodedGatewayEvents = mintReceipt.logs.flatMap((log) => {
			try {
				return [decodeEventLog({
					abi: gatewayArtifact.abi,
					data: log.data,
					topics: log.topics,
				})];
			} catch { return []; }
		});
		const proofMinted = decodedGatewayEvents.find((event) => event.eventName === 'ProofMinted');
		const depositConsumed = decodedGatewayEvents.find((event) => event.eventName === 'DepositConsumed');
		assert.ok(proofMinted, 'ProofMinted event was not emitted.');
		assert.ok(depositConsumed, 'DepositConsumed event was not emitted.');
		const recipient = depositVector.intent.recipient as Address;
		const proofMintedArgs = proofMinted.args as unknown as {
			depositId: Hex; sourceTxid: Hex; recipient: Address; amountRaw: bigint; blockHash: Hex;
		};
		assert.equal(proofMintedArgs.depositId, depositVector.depositId);
		assert.equal(proofMintedArgs.sourceTxid, depositVector.txid);
		assert.equal(proofMintedArgs.recipient.toLowerCase(), recipient.toLowerCase());
		assert.equal(proofMintedArgs.amountRaw, depositVector.intent.amountRaw);
		assert.equal(proofMintedArgs.blockHash, depositBlockHash);
		assert.equal(await publicClient.readContract({
			address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [recipient],
		}), depositVector.intent.amountRaw);
		assert.equal(await publicClient.readContract({
			address: token, abi: tokenArtifact.abi, functionName: 'totalSupply',
		}), depositVector.intent.amountRaw);
		assert.equal(await publicClient.readContract({
			address: gateway.address,
			abi: gatewayArtifact.abi,
			functionName: 'processedDeposits',
			args: [depositVector.depositId],
		}), true);
		const sourceOutpoint = await publicClient.readContract({
			address: gateway.address,
			abi: gatewayArtifact.abi,
			functionName: 'sourceOutpointId',
			args: [`0x${depositVector.intent.sourceContractId}`, depositVector.txid, 1],
		}) as Hex;
		const depositConsumedArgs = depositConsumed.args as unknown as {
			depositId: Hex; sourceOutpoint: Hex; sourceTxid: Hex; sourceVout: number;
		};
		assert.equal(depositConsumedArgs.depositId, depositVector.depositId);
		assert.equal(depositConsumedArgs.sourceOutpoint, sourceOutpoint);
		assert.equal(depositConsumedArgs.sourceTxid, depositVector.txid);
		assert.equal(depositConsumedArgs.sourceVout, 1);
		assert.equal(await publicClient.readContract({
			address: gateway.address,
			abi: gatewayArtifact.abi,
			functionName: 'processedSourceOutpoints',
			args: [sourceOutpoint],
		}), true);

		const expectRevertedTransaction = async (
			to: Address,
			data: Hex,
			label: string,
			account: Address = proofSubmitter,
		) => {
			const hash = await walletClient.sendTransaction({ account, to, data, gas: 8_000_000n });
			const receipt = await publicClient.waitForTransactionReceipt({ hash });
			assert.equal(receipt.status, 'reverted', `${label} unexpectedly succeeded.`);
			return receipt.gasUsed;
		};
		const replayGas = await expectRevertedTransaction(
			gateway.address, mintData, 'Same-proof replay',
		);
		assert.equal(await publicClient.readContract({
			address: token, abi: tokenArtifact.abi, functionName: 'totalSupply',
		}), depositVector.intent.amountRaw, 'Replay changed total supply.');
		const mismatchedOffsetData = encodeFunctionData({
			abi: gatewayArtifact.abi,
			functionName: 'mintFromProof',
			args: [{
				...proof,
				signaturePushOffsets: [
					proof.signaturePushOffsets[0] + 1,
					...proof.signaturePushOffsets.slice(1),
				],
			}],
		});
		await expectRevertedTransaction(
			gateway.address, mismatchedOffsetData, 'Mismatched verifier offsets',
		);
		const wrongBranchData = encodeFunctionData({
			abi: gatewayArtifact.abi,
			functionName: 'mintFromProof',
			args: [{ ...proof, transactionIndex: 1 }],
		});
		await expectRevertedTransaction(gateway.address, wrongBranchData, 'Invalid Merkle index');
		const unauthorizedMintData = encodeFunctionData({
			abi: tokenArtifact.abi,
			functionName: 'mintFromProof',
			args: [recipient, 1n],
		});
		await expectRevertedTransaction(token, unauthorizedMintData, 'Unauthorized direct mint');
		const overMaximumSupplyData = encodeFunctionData({
			abi: tokenArtifact.abi,
			functionName: 'mintFromProof',
			args: [recipient, 10_000_001n],
		});
		await expectCallRevert(() => publicClient.call({
			account: gateway.address,
			to: token,
			data: overMaximumSupplyData,
		}), 'Maximum-supply overflow');

		for (const [name, rawTransaction] of Object.entries(depositVector.witnessLayoutMutations)) {
			const data = encodeFunctionData({
				abi: authorizationArtifact.abi,
				functionName: 'verifyAuthorizedTransition',
				args: [
					rawTransaction, depositVector.parents, depositVector.ancestors,
					depositVector.signatureWitnesses, gateway.address, RESERVE_CONTROLLER,
				],
			});
			await expectCallRevert(() => publicClient.call({
				to: authorization.address, data,
			}), `Authorization mutation ${name}`);
		}
		for (const [name, rawTransaction] of Object.entries(depositVector.prefixMutations)) {
			const data = encodeFunctionData({
				abi: prefixArtifact.abi,
				functionName: 'verifyFtUnlockPrefixes',
				args: [
					rawTransaction, depositVector.parents, depositVector.ancestors,
					depositVector.signaturePushOffsets,
				],
			});
			await expectCallRevert(() => publicClient.call({
				to: prefix.address, data,
			}), `Unlock-prefix mutation ${name}`);
		}

		const wrongModuleDeployment = encodeDeployData({
			abi: gatewayArtifact.abi,
			bytecode: gatewayArtifact.bytecode,
			args: [authorization.address, token, RESERVE_CONTROLLER],
		});
		const wrongModuleHash = await walletClient.sendTransaction({
			account: deployer,
			data: wrongModuleDeployment,
			gas: 8_000_000n,
		});
		const wrongModuleReceipt = await publicClient.waitForTransactionReceipt({
			hash: wrongModuleHash,
		});
		assert.equal(wrongModuleReceipt.status, 'reverted', 'Gateway accepted the wrong module runtime.');

		const hardhatPackage = JSON.parse(await readFile(
			resolve(process.cwd(), 'phase3-hardhat/node_modules/hardhat/package.json'), 'utf8',
		)) as { version: string };
		const localResult = {
			schema: 'learningmaterials/phase3e-local-evm/v1',
			chainId: CHAIN_ID,
			hardfork: 'cancun',
			engine: { name: 'hardhat', version: hardhatPackage.version },
			compiler: {
				version: authorizationArtifact.compilerVersion,
				buildInputSha256: authorizationArtifact.buildInputSha256,
			},
			codeHashes: {
				authorizationRuntime: keccak256(authorizationArtifact.deployedBytecode),
				prefixRuntime: keccak256(prefixArtifact.deployedBytecode),
				relayRuntime: keccak256(relayArtifact.deployedBytecode),
				gatewayCreation: keccak256(gatewayArtifact.bytecode),
			},
			deploymentOrder: [
				{ contract: 'TbcAuthorizedTransitionVerifier', address: authorization.address.toLowerCase(),
					gasUsed: authorization.gasUsed.toString() },
				{ contract: 'TbcFtUnlockPrefixVerifierModule', address: prefix.address.toLowerCase(),
					gasUsed: prefix.gasUsed.toString() },
				{ contract: 'TbcProofMintGateway', address: gateway.address.toLowerCase(),
					gasUsed: gateway.gasUsed.toString() },
			],
			gatewayChildren: { relay: relay.toLowerCase(), token: token.toLowerCase() },
			headerGasUsed: RELAY_HEADERS.map((header, index) => ({
				height: header.height, gasUsed: headerGas[index].toString(),
			})),
			mintGasUsed: mintReceipt.gasUsed.toString(),
			replayRevertGasUsed: replayGas.toString(),
			mintedRaw: depositVector.intent.amountRaw.toString(),
			negativeCases: 5 + Object.keys(depositVector.witnessLayoutMutations).length
				+ Object.keys(depositVector.prefixMutations).length + 1,
		};
		const expectedLocalResult = JSON.parse(await readFile(
			resolve(fixtureRoot, 'phase3e-local-evm-v1.json'), 'utf8',
		));
		assert.deepEqual(localResult, expectedLocalResult, 'Phase 3E local manifest changed.');
		console.log(JSON.stringify(localResult, null, 2));
		console.log('Phase 3E local persistent-state deployment, relay, proof mint and replay vectors passed.');
		console.log('The synthetic deposit Merkle root existed only in this disposable local EVM.');
	} finally {
		node.kill('SIGTERM');
		await Promise.race([
			new Promise<void>((resolvePromise) => node.once('exit', () => resolvePromise())),
			delay(5_000).then(() => { if (node.exitCode === null) node.kill('SIGKILL'); }),
		]);
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
