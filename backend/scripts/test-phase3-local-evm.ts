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
import { merkleRootFromBranch, serializeBlockHeader } from '../src/bridge/phase1/tbc-proof.crypto';
import {
	REAL_MT_DEPOSIT_BLOCK, REAL_MT_DEPOSIT_MERKLE_BRANCH, REAL_MT_DEPOSIT_TXID,
} from '../src/bridge/phase1/tbc-test-vectors';
import {
	buildTbcdevBootstrapCommitment, decodeTbcdevBootstrapContext, tbcdevBootstrapProof,
} from '../src/bridge/phase3/bootstrap-history';
import {
	PHASE3D_GATEWAY, RELAY_HEADERS, phase3dEnvelopeVector,
} from './test-phase3-solidity';

const CHAIN_ID = 998;
const RESERVE_CONTROLLER = `0x${'22'.repeat(20)}` as Hex;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

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

interface SyntheticRelayHeader {
	blockHash: Hex;
	parentHash: Hex;
	merkleRoot: Hex;
	skipHash: Hex;
	chainWork: bigint;
	height: number;
	time: number;
	bits: number;
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
	for (let attempt = 0; attempt < 300; attempt += 1) {
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

function seededRandom(seed: number) {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

function flipRandomBit(value: Hex, random: () => number) {
	const bytes = Buffer.from(value.slice(2), 'hex');
	assert.ok(bytes.length > 0, 'Cannot mutate empty bytes.');
	const index = random() % bytes.length;
	bytes[index] ^= 1 << (random() % 8);
	return `0x${bytes.toString('hex')}` as Hex;
}

function randomHash(random: () => number) {
	const bytes = Buffer.alloc(32);
	for (let index = 0; index < bytes.length; index += 4) {
		bytes.writeUInt32BE(random(), index);
	}
	return `0x${bytes.toString('hex')}` as Hex;
}

function syntheticMerkleProof(displayedTxid: Hex, depth: number) {
	assert.ok(Number.isSafeInteger(depth) && depth >= 0 && depth <= 12);
	const transactionCount = 2 ** depth;
	const transactionIndex = depth === 0 ? 0 : Math.floor(transactionCount / 3);
	const steps = Array.from({ length: depth }, (_, level) => ({
		hash: keccak256(encodeAbiParameters(
			[{ type: 'bytes32' }, { type: 'uint32' }], [displayedTxid, level],
		)).slice(2),
		side: ((transactionIndex >>> level) & 1) === 1 ? 'left' as const : 'right' as const,
	}));
	return {
		transactionIndex,
		transactionCount,
		displayedSiblings: steps.map(({ hash }) => `0x${hash}` as Hex),
		merkleRoot: `0x${merkleRootFromBranch(displayedTxid.slice(2), steps)}` as Hex,
	};
}

function invertLowestOne(value: number) {
	return value === 0 ? 0 : (value & (value - 1)) >>> 0;
}

function relaySkipHeight(height: number) {
	if (height < 2) return 0;
	return (height & 1) === 1
		? invertLowestOne(invertLowestOne(height - 1)) + 1
		: invertLowestOne(height);
}

function syntheticRelayBranch(
	label: string,
	length: number,
	checkpoint: SyntheticRelayHeader,
	workPerHeader: bigint,
) {
	const labelHash = keccak256(toHex(label));
	const hashesByHeight = new Map<number, Hex>([[checkpoint.height, checkpoint.blockHash]]);
	const branch: SyntheticRelayHeader[] = [];
	let parentHash = checkpoint.blockHash;
	for (let offset = 1; offset <= length; offset += 1) {
		const height = checkpoint.height + offset;
		const blockHash = keccak256(encodeAbiParameters(
			[{ type: 'bytes32' }, { type: 'uint32' }], [labelHash, height],
		));
		const skipHeight = relaySkipHeight(height);
		const skipHash = skipHeight < checkpoint.height
			? ZERO_HASH
			: hashesByHeight.get(skipHeight);
		assert.ok(skipHash, `Missing synthetic ${label} skip ancestor ${skipHeight}.`);
		branch.push({
			blockHash,
			parentHash,
			merkleRoot: keccak256(encodeAbiParameters(
				[{ type: 'bytes32' }, { type: 'bytes32' }], [labelHash, blockHash],
			)),
			skipHash,
			chainWork: checkpoint.chainWork + workPerHeader * BigInt(offset),
			height,
			time: checkpoint.time + offset * 60,
			bits: checkpoint.bits,
		});
		hashesByHeight.set(height, blockHash);
		parentHash = blockHash;
	}
	return branch;
}

async function injectSyntheticRelayHeader(
	rpcUrl: string,
	relay: Address,
	header: SyntheticRelayHeader,
) {
	const base = BigInt(keccak256(encodeAbiParameters(
		[{ type: 'bytes32' }, { type: 'uint256' }], [header.blockHash, 0n],
	)));
	const slot = (offset: bigint) => toHex(base + offset, { size: 32 });
	const packed = BigInt(header.height) | (BigInt(header.time) << 32n)
		| (BigInt(header.bits) << 64n) | (1n << 96n);
	const values = [
		header.parentHash,
		header.merkleRoot,
		header.skipHash,
		toHex(header.chainWork, { size: 32 }),
		toHex(packed, { size: 32 }),
	] as const;
	for (const [index, value] of values.entries()) {
		await jsonRpc(rpcUrl, 'hardhat_setStorageAt', [relay, slot(BigInt(index)), value]);
	}
}

async function setSyntheticBestChain(
	rpcUrl: string,
	relay: Address,
	tip: SyntheticRelayHeader,
	bestWorkTie: boolean,
) {
	const storageSlot = (value: bigint) => toHex(value, { size: 32 });
	await jsonRpc(rpcUrl, 'hardhat_setStorageAt', [relay, storageSlot(1n), tip.blockHash]);
	await jsonRpc(rpcUrl, 'hardhat_setStorageAt', [
		relay, storageSlot(2n), toHex(tip.chainWork, { size: 32 }),
	]);
	await jsonRpc(rpcUrl, 'hardhat_setStorageAt', [
		relay, storageSlot(3n), toHex(bestWorkTie ? 1n : 0n, { size: 32 }),
	]);
	await jsonRpc(rpcUrl, 'evm_mine');
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
			tokenArtifact, verifierArtifact] = await Promise.all([
			loadArtifact('TbcAuthorizedTransitionVerifier'),
			loadArtifact('TbcFtUnlockPrefixVerifierModule'),
			loadArtifact('TbcProofMintGateway'),
			loadArtifact('TbcHeaderRelayV2'),
			loadArtifact('WrappedFTV2'),
			loadArtifact('TbcVerifierHarness'),
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
		const verifierHarness = await deploy(verifierArtifact);

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

		const realMerkleSiblings = REAL_MT_DEPOSIT_MERKLE_BRANCH.siblings.map(
			(sibling) => `0x${sibling}` as Hex,
		);
		const realMerkleData = encodeFunctionData({
			abi: verifierArtifact.abi,
			functionName: 'reconstructMerkleRoot',
			args: [
				`0x${REAL_MT_DEPOSIT_TXID}`,
				REAL_MT_DEPOSIT_MERKLE_BRANCH.transactionIndex,
				REAL_MT_DEPOSIT_MERKLE_BRANCH.transactionCount,
				realMerkleSiblings,
			],
		});
		assert.equal(await publicClient.readContract({
			address: verifierHarness.address,
			abi: verifierArtifact.abi,
			functionName: 'reconstructMerkleRoot',
			args: [
				`0x${REAL_MT_DEPOSIT_TXID}`,
				REAL_MT_DEPOSIT_MERKLE_BRANCH.transactionIndex,
				REAL_MT_DEPOSIT_MERKLE_BRANCH.transactionCount,
				realMerkleSiblings,
			],
		}), `0x${REAL_MT_DEPOSIT_BLOCK.merkleRoot}`);
		const realMerkleGas = await publicClient.estimateGas({
			account: proofSubmitter,
			to: verifierHarness.address,
			data: realMerkleData,
		});

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
		let relayWitnessFuzzCases = 0;
		let relayWitnessPermutationCases = 0;
		for (const [index, header] of RELAY_HEADERS.entries()) {
			const canonicalWitnesses = relayWitnesses[index];
			const firstWitness = canonicalWitnesses[0];
			assert.ok(firstWitness && firstWitness.siblings.length > 0);
			const malformedWitnesses = [
				canonicalWitnesses.slice(0, -1),
				[...canonicalWitnesses, firstWitness],
				[
					{ ...firstWitness, point: { ...firstWitness.point, bits: firstWitness.point.bits ^ 1 } },
					...canonicalWitnesses.slice(1),
				],
				[
					{
						...firstWitness,
						siblings: [
							flipRandomBit(firstWitness.siblings[0], seededRandom(header.height)),
							...firstWitness.siblings.slice(1),
						],
					},
					...canonicalWitnesses.slice(1),
				],
			];
			const permutedWitnessData = encodeFunctionData({
				abi: relayArtifact.abi,
				functionName: 'submitHeader',
				args: [
					`0x${serializeBlockHeader(header).toString('hex')}`,
					[...canonicalWitnesses].reverse(),
				],
			});
			await publicClient.call({ to: relay, data: permutedWitnessData });
			relayWitnessPermutationCases += 1;
			for (const [mutationIndex, witnesses] of malformedWitnesses.entries()) {
				const data = encodeFunctionData({
					abi: relayArtifact.abi,
					functionName: 'submitHeader',
					args: [`0x${serializeBlockHeader(header).toString('hex')}`, witnesses],
				});
				await expectCallRevert(() => publicClient.call({
					to: relay, data,
				}), `Header ${header.height} witness mutation ${mutationIndex}`);
				relayWitnessFuzzCases += 1;
			}
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
		const recipient = depositVector.intent.recipient as Address;
		const sourceOutpoint = await publicClient.readContract({
			address: gateway.address,
			abi: gatewayArtifact.abi,
			functionName: 'sourceOutpointId',
			args: [`0x${depositVector.intent.sourceContractId}`, depositVector.txid, 1],
		}) as Hex;
		const fuzzSeed = 0x5eed3f01;
		const random = seededRandom(fuzzSeed);
		const proofFuzzCases = 64;
		for (let caseIndex = 0; caseIndex < proofFuzzCases; caseIndex += 1) {
			const mutated = {
				...proof,
				displayedSiblings: [...proof.displayedSiblings],
				parentTransactions: [...proof.parentTransactions],
				ancestorTransactions: proof.ancestorTransactions.map((group) => [...group]),
				signatureWitnesses: proof.signatureWitnesses.map((witness) => ({ ...witness })),
				signaturePushOffsets: [...proof.signaturePushOffsets],
			};
			switch (caseIndex % 8) {
				case 0:
					mutated.blockHash = randomHash(random);
					break;
				case 1:
					mutated.rawTransaction = flipRandomBit(mutated.rawTransaction, random);
					break;
				case 2:
					mutated.transactionIndex = 1;
					break;
				case 3:
					mutated.transactionCount = 2;
					mutated.displayedSiblings = [randomHash(random)];
					break;
				case 4: {
					const parentIndex = random() % mutated.parentTransactions.length;
					mutated.parentTransactions[parentIndex] = flipRandomBit(
						mutated.parentTransactions[parentIndex], random,
					);
					break;
				}
				case 5: {
					const nonEmptyGroups = mutated.ancestorTransactions
						.map((group, groupIndex) => ({ group, groupIndex }))
						.filter(({ group }) => group.length > 0);
					const selected = nonEmptyGroups[random() % nonEmptyGroups.length];
					const ancestorIndex = random() % selected.group.length;
					mutated.ancestorTransactions[selected.groupIndex][ancestorIndex] = flipRandomBit(
						selected.group[ancestorIndex], random,
					);
					break;
				}
				case 6: {
					const witnessIndex = random() % mutated.signatureWitnesses.length;
					mutated.signatureWitnesses[witnessIndex].publicKeyX = flipRandomBit(
						mutated.signatureWitnesses[witnessIndex].publicKeyX, random,
					);
					break;
				}
				default: {
					const offsetIndex = random() % mutated.signaturePushOffsets.length;
					mutated.signaturePushOffsets[offsetIndex] += 1 + (random() % 31);
				}
			}
			const data = encodeFunctionData({
				abi: gatewayArtifact.abi,
				functionName: 'mintFromProof',
				args: [mutated],
			});
			await expectCallRevert(() => publicClient.call({
				to: gateway.address, data,
			}), `Seed ${fuzzSeed.toString(16)} proof mutation ${caseIndex}`);
		}
		assert.equal(await publicClient.readContract({
			address: token, abi: tokenArtifact.abi, functionName: 'totalSupply',
		}), 0n, 'Proof fuzz changed total supply.');
		assert.equal(await publicClient.readContract({
			address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [recipient],
		}), 0n, 'Proof fuzz changed recipient balance.');
		assert.equal(await publicClient.readContract({
			address: gateway.address, abi: gatewayArtifact.abi,
			functionName: 'processedDeposits', args: [depositVector.depositId],
		}), false, 'Proof fuzz consumed the logical deposit ID.');
		assert.equal(await publicClient.readContract({
			address: gateway.address, abi: gatewayArtifact.abi,
			functionName: 'processedSourceOutpoints', args: [sourceOutpoint],
		}), false, 'Proof fuzz consumed the source outpoint.');

		const proofDepthProfiles = [];
		for (const depth of [0, 2, 4, 8, 12]) {
			const merkle = syntheticMerkleProof(depositVector.txid, depth);
			await jsonRpc(rpcUrl, 'hardhat_setStorageAt', [
				relay, merkleRootSlot, merkle.merkleRoot,
			]);
			await jsonRpc(rpcUrl, 'evm_mine');
			const profiledProof = {
				...proof,
				transactionIndex: merkle.transactionIndex,
				transactionCount: merkle.transactionCount,
				displayedSiblings: merkle.displayedSiblings,
			};
			const data = encodeFunctionData({
				abi: gatewayArtifact.abi,
				functionName: 'mintFromProof',
				args: [profiledProof],
			});
			const gasEstimate = await publicClient.estimateGas({
				account: proofSubmitter,
				to: gateway.address,
				data,
			});
			proofDepthProfiles.push({
				depth,
				transactionCount: merkle.transactionCount,
				transactionIndex: merkle.transactionIndex,
				calldataBytes: (data.length - 2) / 2,
				gasEstimate: gasEstimate.toString(),
			});
		}
		const oneLeafProfile = proofDepthProfiles[0];
		assert.ok(oneLeafProfile);
		for (const [index, profile] of proofDepthProfiles.entries()) {
			assert.equal(
				profile.calldataBytes,
				oneLeafProfile.calldataBytes + profile.depth * 32,
				`Merkle depth ${profile.depth} did not add exactly one word per sibling.`,
			);
			if (index > 0) {
				assert.ok(
					BigInt(profile.gasEstimate) > BigInt(proofDepthProfiles[index - 1].gasEstimate),
					`Merkle depth ${profile.depth} did not increase the gas estimate.`,
				);
			}
		}
		await jsonRpc(rpcUrl, 'hardhat_setStorageAt', [relay, merkleRootSlot, depositVector.txid]);
		await jsonRpc(rpcUrl, 'evm_mine');
		assert.equal((await publicClient.readContract({
			address: relay,
			abi: relayArtifact.abi,
			functionName: 'header',
			args: [depositBlockHash],
		}) as { merkleRoot: Hex }).merkleRoot, depositVector.txid);

		const transactionBytes = (depositVector.raw.length - 2) / 2;
		const parentBytes = depositVector.parents.reduce(
			(total, parent) => total + (parent.length - 2) / 2, 0,
		);
		const ancestorBytes = depositVector.ancestors.flat().reduce(
			(total, ancestor) => total + (ancestor.length - 2) / 2, 0,
		);
		const benchmarkResult = {
			schema: 'learningmaterials/phase3h-proof-size-gas/v1',
			parentManifest: 'phase3g-reorg-v1.json',
			evidenceBytes: {
				transaction: transactionBytes,
				parents: parentBytes,
				ancestors: ancestorBytes,
				total: transactionBytes + parentBytes + ancestorBytes,
			},
			realTbcMerkleVector: {
				blockHeight: REAL_MT_DEPOSIT_BLOCK.height,
				transactionCount: REAL_MT_DEPOSIT_MERKLE_BRANCH.transactionCount,
				transactionIndex: REAL_MT_DEPOSIT_MERKLE_BRANCH.transactionIndex,
				branchDepth: REAL_MT_DEPOSIT_MERKLE_BRANCH.siblings.length,
				calldataBytes: (realMerkleData.length - 2) / 2,
				gasEstimate: realMerkleGas.toString(),
			},
			proofDepthProfiles,
			confirmationPolicy: {
				contractMinimum: 6,
				productionStatus: 'unresolved',
				reason: 'a source reorg cannot roll back an existing destination mint',
				requiredInputs: [
					'observed TBC reorganization depth and frequency',
					'chainwork attack-cost model',
					'deposit-value exposure limit',
					'acceptable mint latency',
				],
			},
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
		assert.equal(
			mintReceipt.gasUsed.toString(), oneLeafProfile.gasEstimate,
			'One-leaf estimate differs from the persistent mint gas.',
		);
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
		const fuzzResult = {
			schema: 'learningmaterials/phase3f-seeded-fuzz/v1',
			parentManifest: 'phase3e-local-evm-v1.json',
			seed: `0x${fuzzSeed.toString(16)}`,
			proofEnvelopeCases: proofFuzzCases,
			relayWitnessRejectCases: relayWitnessFuzzCases,
			relayWitnessPermutationCases,
			invariants: [
				'all mutated proof envelopes revert',
				'malformed relay witness sets revert',
				'relay witness ordering is permutation invariant',
				'fuzz calls do not consume either replay key',
				'fuzz calls do not change wrapped supply or recipient balance',
				'canonical proof still mints after the fuzz corpus',
			],
		};
		const expectedFuzzResult = JSON.parse(await readFile(
			resolve(fixtureRoot, 'phase3f-seeded-fuzz-v1.json'), 'utf8',
		));
		assert.deepEqual(fuzzResult, expectedFuzzResult, 'Phase 3F fuzz manifest changed.');
		const expectedBenchmarkResult = JSON.parse(await readFile(
			resolve(fixtureRoot, 'phase3h-proof-size-gas-v1.json'), 'utf8',
		));
		assert.deepEqual(
			benchmarkResult, expectedBenchmarkResult, 'Phase 3H benchmark manifest changed.',
		);

		// Phase 3G injects already-retained header nodes into this disposable chain.
		// It deliberately does not claim to reproduce submitHeader: mining 68 headers
		// at the frozen testnet target would make this regression test impractical.
		const checkpointPoint = bootstrapPoints.at(-1)!;
		const checkpoint: SyntheticRelayHeader = {
			blockHash: `0x${checkpointPoint.blockHash}`,
			parentHash: ZERO_HASH,
			merkleRoot: ZERO_HASH,
			skipHash: ZERO_HASH,
			chainWork: checkpointPoint.chainWork,
			height: checkpointPoint.height,
			time: checkpointPoint.time,
			bits: checkpointPoint.bits,
		};
		const branchLength = 34;
		const syntheticWorkPerHeader = blockWork(checkpoint.bits);
		const branchA = syntheticRelayBranch(
			'phase3g-branch-a', branchLength, checkpoint, syntheticWorkPerHeader,
		);
		const branchB = syntheticRelayBranch(
			'phase3g-branch-b', branchLength, checkpoint, syntheticWorkPerHeader,
		);
		for (const header of [...branchA, ...branchB]) {
			await injectSyntheticRelayHeader(rpcUrl, relay, header);
		}
		const isFinalized = (blockHash: Hex) => publicClient.readContract({
			address: relay, abi: relayArtifact.abi, functionName: 'isFinalized', args: [blockHash],
		}) as Promise<boolean>;
		const isCanonical = (blockHash: Hex) => publicClient.readContract({
			address: relay,
			abi: relayArtifact.abi,
			functionName: 'isCanonical',
			args: [blockHash, 6],
		}) as Promise<boolean>;
		const assertBestState = async (tip: SyntheticRelayHeader, tie: boolean) => {
			assert.equal(await publicClient.readContract({
				address: relay, abi: relayArtifact.abi, functionName: 'bestTip',
			}), tip.blockHash);
			assert.equal(await publicClient.readContract({
				address: relay, abi: relayArtifact.abi, functionName: 'bestChainWork',
			}), tip.chainWork);
			assert.equal(await publicClient.readContract({
				address: relay, abi: relayArtifact.abi, functionName: 'bestWorkTie',
			}), tie);
		};

		await setSyntheticBestChain(rpcUrl, relay, branchA[31], false);
		await assertBestState(branchA[31], false);
		assert.equal(await isFinalized(branchA[0].blockHash), true);
		assert.equal(await isFinalized(branchB[0].blockHash), false);

		assert.equal(branchA[31].chainWork, branchB[31].chainWork);
		await setSyntheticBestChain(rpcUrl, relay, branchA[31], true);
		await assertBestState(branchA[31], true);
		assert.equal(await isFinalized(branchA[0].blockHash), false);
		assert.equal(await isFinalized(branchB[0].blockHash), false);

		await setSyntheticBestChain(rpcUrl, relay, branchB[32], false);
		await assertBestState(branchB[32], false);
		assert.equal(await isFinalized(branchB[0].blockHash), true);
		assert.equal(await isFinalized(branchA[0].blockHash), false);
		assert.equal(await isCanonical(branchB[27].blockHash), true);
		assert.equal(await isCanonical(branchB[28].blockHash), false);
		assert.equal(await publicClient.readContract({
			address: relay,
			abi: relayArtifact.abi,
			functionName: 'ancestor',
			args: [branchB[32].blockHash, checkpoint.height + 16],
		}), branchB[15].blockHash);

		assert.equal(branchA[32].chainWork, branchB[32].chainWork);
		await setSyntheticBestChain(rpcUrl, relay, branchB[32], true);
		await assertBestState(branchB[32], true);
		assert.equal(await isFinalized(branchA[0].blockHash), false);
		assert.equal(await isFinalized(branchB[0].blockHash), false);

		await setSyntheticBestChain(rpcUrl, relay, branchA[33], false);
		await assertBestState(branchA[33], false);
		assert.equal(await isFinalized(branchA[0].blockHash), true);
		assert.equal(await isFinalized(branchB[0].blockHash), false);
		assert.equal(await isCanonical(branchA[28].blockHash), true);
		assert.equal(await isCanonical(branchA[29].blockHash), false);
		assert.equal(await isFinalized(depositBlockHash), false);
		assert.equal(await publicClient.readContract({
			address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [recipient],
		}), depositVector.intent.amountRaw, 'Source reorg changed an already-minted EVM balance.');
		assert.equal(await publicClient.readContract({
			address: gateway.address,
			abi: gatewayArtifact.abi,
			functionName: 'processedDeposits',
			args: [depositVector.depositId],
		}), true, 'Source reorg cleared a consumed logical deposit ID.');
		assert.equal(await publicClient.readContract({
			address: gateway.address,
			abi: gatewayArtifact.abi,
			functionName: 'processedSourceOutpoints',
			args: [sourceOutpoint],
		}), true, 'Source reorg cleared a consumed source outpoint.');

		const reorgResult = {
			schema: 'learningmaterials/phase3g-reorg/v1',
			parentManifest: 'phase3f-seeded-fuzz-v1.json',
			setup: 'hardhat retained-header storage injection',
			forkHeight: checkpoint.height,
			branchLength,
			syntheticWorkPerHeader: syntheticWorkPerHeader.toString(),
			minimumConfirmations: 6,
			winnerSequence: [
				'branch-a@32', 'equal-work-tie@32', 'branch-b@33',
				'equal-work-tie@33', 'branch-a@34',
			],
			deepestReplacedBranchLength: 33,
			invariants: [
				'equal-work ties fail closed for both branches',
				'only the unique greatest-work branch is canonical',
				'six confirmations include the queried block',
				'ancestor queries follow the selected deep branch',
				'a source-chain reorg cannot roll back an existing EVM mint',
				'replay keys remain consumed after a source-chain reorg',
			],
		};
		const expectedReorgResult = JSON.parse(await readFile(
			resolve(fixtureRoot, 'phase3g-reorg-v1.json'), 'utf8',
		));
		assert.deepEqual(reorgResult, expectedReorgResult, 'Phase 3G reorg manifest changed.');
		console.log(JSON.stringify({
			...localResult, fuzz: fuzzResult, reorg: reorgResult, benchmark: benchmarkResult,
		}, null, 2));
		console.log('Phase 3E local persistent-state deployment, relay, proof mint and replay vectors passed.');
		console.log('Phase 3F seeded proof-envelope and relay-witness fuzz vectors passed.');
		console.log('Phase 3G deep competing-branch, tie and source-reorg vectors passed.');
		console.log('Phase 3H proof-size, Merkle-depth and gas vectors passed.');
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
