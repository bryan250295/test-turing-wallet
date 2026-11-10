import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { keccak256 } from 'viem';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = JSON.parse(await readFile(resolve(root, '../shared/src/config/phase3-testnet-v3-candidate.json'), 'utf8'));
const v2Deployment = JSON.parse(await readFile(resolve(root, 'src/generated/phase3-testnet-v2-deployment.json'), 'utf8'));
const v2Public = JSON.parse(await readFile(resolve(root, '../shared/src/config/phase3-testnet-v2-public.json'), 'utf8'));
if (candidate.status !== 'candidate-not-deployed' || candidate.safety?.broadcast !== false) throw new Error('V3 checkpoint candidate is not a safe, unbroadcast preparation.');
if (candidate.requiredConfirmations !== 6 || candidate.observedTip + 1 < candidate.checkpoint.height + candidate.requiredConfirmations) throw new Error('V3 checkpoint candidate was not selected with six confirmations.');

const dependencyRoot = resolve(root, 'node_modules/@openzeppelin/contracts');
if (!solc.version().startsWith('0.8.30+')) throw new Error('Install the pinned Solidity compiler 0.8.30.');
const openzeppelin = JSON.parse(await readFile(resolve(dependencyRoot, 'package.json'), 'utf8'));
if (openzeppelin.version !== '5.4.0') throw new Error('Install the pinned OpenZeppelin Contracts 5.4.0.');

const existingSourceNames = [
	'contracts/phase3/TbcProofVerifier.sol',
	'contracts/phase3/TbcDifficultyVerifier.sol',
	'contracts/phase3/TbcBoundedTransaction.sol',
	'contracts/phase3/TbcBridgeDepositVerifier.sol',
	'contracts/phase3/TbcInputAuthorization.sol',
	'contracts/phase3/TbcStandaloneInputAuthorization.sol',
	'contracts/phase3/TbcPartialSha256.sol',
	'contracts/phase3/TbcFtUnlockPrefixVerifier.sol',
	'contracts/phase3/TbcDepositReplayProtection.sol',
	'contracts/phase3/TbcAuthorizedTransitionVerifier.sol',
	'contracts/phase3/TbcAuthenticatedTransitionVerifier.sol',
	'contracts/phase3/TbcInputSignatureVerifier.sol',
	'contracts/phase3/TbcFinalizedDepositVerifier.sol',
	'contracts/phase3/TbcFtUnlockPrefixVerifierModule.sol',
	'contracts/phase3/WrappedFTV2.sol',
];
const sources = Object.fromEntries(await Promise.all(existingSourceNames.map(async (sourceName) => [
	sourceName,
	{ content: await readFile(resolve(root, sourceName), 'utf8') },
])));

function solidityUint(value, label, maximum = 0xffffffff) {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${label} is invalid.`);
	return String(value);
}
function solidityBytes32(value, label) {
	if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} is invalid.`);
	return value.toLowerCase();
}

const checkpoint = candidate.checkpoint;
const bootstrap = candidate.bootstrap;
const verifierSource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Verifies DAA points committed by the prepared public Testnet checkpoint v3.
library TbcBootstrapVerifierTestnetV3 {
    bytes32 internal constant CONTEXT_DOMAIN_HASH = ${solidityBytes32(bootstrap.commitmentDomainHash, 'Commitment domain hash')};
    bytes32 internal constant CHECKPOINT_HASH = ${solidityBytes32(checkpoint.hash, 'Checkpoint hash')};
    bytes32 internal constant COMMITMENT_ROOT = ${solidityBytes32(bootstrap.commitmentRoot, 'Commitment root')};
    uint32 internal constant START_HEIGHT = ${solidityUint(bootstrap.startHeight, 'Bootstrap start height')};
    uint32 internal constant END_HEIGHT = ${solidityUint(bootstrap.endHeight, 'Bootstrap end height')};
    uint32 internal constant POINT_COUNT = ${solidityUint(bootstrap.pointCount, 'Bootstrap point count')};
    uint256 internal constant PROOF_LENGTH = ${solidityUint(bootstrap.checkpointProof.length, 'Bootstrap proof length', 256)};

    struct Point { uint32 height; bytes32 blockHash; uint32 time; uint32 bits; uint256 chainWork; }

    function leaf(Point memory point) internal pure returns (bytes32) {
        return keccak256(abi.encode(CONTEXT_DOMAIN_HASH, CHECKPOINT_HASH, point.height, point.blockHash, point.time, point.bits, point.chainWork));
    }

    function verify(Point memory point, bytes32[] calldata siblings) internal pure returns (bool) {
        if (point.height < START_HEIGHT || point.height > END_HEIGHT || siblings.length != PROOF_LENGTH) return false;
        uint256 index = point.height - START_HEIGHT;
        uint256 width = POINT_COUNT;
        bytes32 current = leaf(point);
        for (uint256 level; level < siblings.length; ++level) {
            bytes32 sibling = siblings[level];
            if ((width & 1) == 1 && index == width - 1 && sibling != current) return false;
            current = (index & 1) == 1 ? keccak256(abi.encodePacked(sibling, current)) : keccak256(abi.encodePacked(current, sibling));
            index /= 2;
            width = (width + 1) / 2;
        }
        return current == COMMITMENT_ROOT;
    }
}
`;

const v2Relay = await readFile(resolve(root, 'contracts/phase3/TbcHeaderRelayTestnetV2.sol'), 'utf8');
let relaySource = v2Relay
	.replaceAll('TbcBootstrapVerifierV2', 'TbcBootstrapVerifierTestnetV3')
	.replace('"./TbcProofVerifier.sol"', '"../TbcProofVerifier.sol"')
	.replace('"./TbcDifficultyVerifier.sol"', '"../TbcDifficultyVerifier.sol"')
	.replaceAll('TbcHeaderRelayTestnetV2', 'TbcHeaderRelayTestnetV3')
	.replace('public TBC Testnet MT route anchored at checkpoint v2', 'public TBC Testnet MT route anchored at checkpoint v3')
	.replace(/uint32 public constant CHECKPOINT_HEIGHT = [^;]+;/, `uint32 public constant CHECKPOINT_HEIGHT = ${solidityUint(checkpoint.height, 'Checkpoint height')};`)
	.replace(/bytes32 public constant CHECKPOINT_HASH =\s*0x[0-9a-f]+;/i, `bytes32 public constant CHECKPOINT_HASH = ${solidityBytes32(checkpoint.hash, 'Checkpoint hash')};`)
	.replace(/bytes32 public constant CHECKPOINT_MERKLE_ROOT =\s*0x[0-9a-f]+;/i, `bytes32 public constant CHECKPOINT_MERKLE_ROOT = ${solidityBytes32(checkpoint.merkleRoot, 'Checkpoint Merkle root')};`)
	.replace(/uint32 public constant CHECKPOINT_TIME = [^;]+;/, `uint32 public constant CHECKPOINT_TIME = ${solidityUint(checkpoint.time, 'Checkpoint time')};`)
	.replace(/uint32 public constant CHECKPOINT_BITS = 0x[0-9a-f]+;/i, `uint32 public constant CHECKPOINT_BITS = 0x${Number(checkpoint.bits).toString(16)};`)
	.replace(/uint256 public constant CHECKPOINT_CHAIN_WORK =\s*0x[0-9a-f]+;/i, `uint256 public constant CHECKPOINT_CHAIN_WORK = ${solidityBytes32(checkpoint.chainWork, 'Checkpoint chainwork')};`)
	.replace(/bytes32 public constant BOOTSTRAP_COMMITMENT_ROOT =\s*0x[0-9a-f]+;/i, `bytes32 public constant BOOTSTRAP_COMMITMENT_ROOT = ${solidityBytes32(bootstrap.commitmentRoot, 'Commitment root')};`);
if (!relaySource.includes(`CHECKPOINT_HEIGHT = ${checkpoint.height};`) || relaySource.includes('840_039')) throw new Error('Failed to bind the generated V3 Relay checkpoint.');

const generatedSourceRoot = resolve(root, 'contracts/phase3/generated');
await mkdir(generatedSourceRoot, { recursive: true });
await writeFile(resolve(generatedSourceRoot, 'TbcBootstrapVerifierTestnetV3.sol'), verifierSource);
await writeFile(resolve(generatedSourceRoot, 'TbcHeaderRelayTestnetV3.sol'), relaySource);
sources['contracts/phase3/generated/TbcBootstrapVerifierTestnetV3.sol'] = { content: verifierSource };
sources['contracts/phase3/generated/TbcHeaderRelayTestnetV3.sol'] = { content: relaySource };

const settings = {
	evmVersion: 'cancun',
	optimizer: { enabled: true, runs: 200 },
	outputSelection: { '*': { '': ['ast'], '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'metadata'] } },
};
function readImport(path) {
	if (!path.startsWith('@openzeppelin/contracts/')) return { error: `Unsupported import: ${path}` };
	const resolved = resolve(root, 'node_modules', path);
	if (!resolved.startsWith(`${dependencyRoot}${sep}`)) return { error: `Import outside dependency: ${path}` };
	try {
		const content = readFileSync(resolved, 'utf8');
		sources[path] = { content };
		return { contents: content };
	} catch { return { error: `Cannot read import: ${path}` }; }
}
function compile(inputSources, label) {
	const input = { language: 'Solidity', sources: inputSources, settings };
	const output = JSON.parse(solc.compile(JSON.stringify(input), { import: readImport }));
	for (const diagnostic of output.errors ?? []) console.error(diagnostic.formattedMessage);
	if ((output.errors ?? []).some((entry) => entry.severity === 'error')) throw new Error(`${label} compilation failed; no deployment was prepared.`);
	return { input, output };
}
const first = compile(sources, 'V3 Relay');
const relayCompiled = first.output.contracts?.['contracts/phase3/generated/TbcHeaderRelayTestnetV3.sol']?.TbcHeaderRelayTestnetV3;
if (!relayCompiled?.evm?.deployedBytecode?.object) throw new Error('V3 Relay artifact is missing.');
const relayRuntimeHash = keccak256(`0x${relayCompiled.evm.deployedBytecode.object}`);

const v2Gateway = await readFile(resolve(root, 'contracts/phase3/TbcProofMintGatewayTestnetV2.sol'), 'utf8');
const gatewaySource = v2Gateway
	.replaceAll('TbcProofMintGatewayTestnetV2', 'TbcProofMintGatewayTestnetV3')
	.replaceAll('checkpoint v2', 'checkpoint v3')
	.replaceAll('from "./', 'from "../')
	.replace(/bytes32 public constant RELAY_RUNTIME_CODEHASH =\s*0x[0-9a-f]+;/i, `bytes32 public constant RELAY_RUNTIME_CODEHASH = ${relayRuntimeHash};`);
if (!gatewaySource.includes(relayRuntimeHash)) throw new Error('Failed to bind the V3 Gateway to the generated Relay runtime.');
await writeFile(resolve(generatedSourceRoot, 'TbcProofMintGatewayTestnetV3.sol'), gatewaySource);
sources['contracts/phase3/generated/TbcProofMintGatewayTestnetV3.sol'] = { content: gatewaySource };

const compiled = compile(sources, 'V3 Gateway');
const gatewayCompiled = compiled.output.contracts?.['contracts/phase3/generated/TbcProofMintGatewayTestnetV3.sol']?.TbcProofMintGatewayTestnetV3;
if (!gatewayCompiled?.evm?.bytecode?.object) throw new Error('V3 Gateway artifact is missing.');
const finalRelay = compiled.output.contracts?.['contracts/phase3/generated/TbcHeaderRelayTestnetV3.sol']?.TbcHeaderRelayTestnetV3;
if (!finalRelay?.evm?.bytecode?.object || keccak256(`0x${finalRelay.evm.deployedBytecode.object}`) !== relayRuntimeHash) throw new Error('V3 Relay changed between compile passes.');

const buildInput = { ...compiled.input, sources };
const buildInputSha256 = createHash('sha256').update(JSON.stringify(buildInput)).digest('hex');
const artifactRoot = resolve(root, 'artifacts/phase3-v3');
await mkdir(artifactRoot, { recursive: true });
for (const [contractName, sourceName, artifact] of [
	['TbcHeaderRelayTestnetV3', 'contracts/phase3/generated/TbcHeaderRelayTestnetV3.sol', finalRelay],
	['TbcProofMintGatewayTestnetV3', 'contracts/phase3/generated/TbcProofMintGatewayTestnetV3.sol', gatewayCompiled],
]) {
	const bytecode = `0x${artifact.evm.bytecode.object}`;
	const deployedBytecode = `0x${artifact.evm.deployedBytecode.object}`;
	if (deployedBytecode.length / 2 - 1 > 24_576) throw new Error(`${contractName} exceeds the EVM deployed code-size limit.`);
	await writeFile(resolve(artifactRoot, `${contractName}.json`), `${JSON.stringify({
		contractName, sourceName, compilerVersion: solc.version(), targetChainId: 998,
		buildInputSha256, settings, abi: artifact.abi, bytecode, deployedBytecode,
		immutableReferences: artifact.evm.deployedBytecode.immutableReferences ?? {}, metadata: JSON.parse(artifact.metadata), buildInput,
	}, null, 2)}\n`);
}

const deploymentManifest = {
	schema: 'learningmaterials/phase3-public-testnet-v3-deployment/v1',
	status: 'prepared-not-deployed',
	chainId: 998,
	preparedAt: new Date().toISOString(),
	checkpoint: candidate.checkpoint,
	bootstrap: candidate.bootstrap,
	reuse: {
		reserveController: v2Public.reserveController,
		finalized: { address: v2Public.contracts.finalized, runtimeCodeHash: v2Deployment.contracts.finalized.runtimeCodeHash },
		transition: { address: v2Public.contracts.transition, runtimeCodeHash: v2Deployment.contracts.transition.runtimeCodeHash },
		signature: { address: v2Public.contracts.signature, runtimeCodeHash: v2Deployment.contracts.signature.runtimeCodeHash },
		prefix: { address: v2Public.contracts.prefix, runtimeCodeHash: v2Deployment.contracts.prefix.runtimeCodeHash },
	},
	contracts: {
		relay: {
			contractName: 'TbcHeaderRelayTestnetV3',
			bytecode: `0x${finalRelay.evm.bytecode.object}`,
			runtimeCodeHash: relayRuntimeHash,
		},
		gateway: {
			contractName: 'TbcProofMintGatewayTestnetV3',
			bytecode: `0x${gatewayCompiled.evm.bytecode.object}`,
			creationCodeHash: keccak256(`0x${gatewayCompiled.evm.bytecode.object}`),
			expectedRelayRuntimeCodeHash: relayRuntimeHash,
		},
	},
	buildInputSha256,
	safety: { broadcast: false, oldRouteAction: 'paused', requiresExplicitWalletConfirmation: true },
};
const generatedRoot = resolve(root, 'src/generated');
await mkdir(generatedRoot, { recursive: true });
await writeFile(resolve(generatedRoot, 'phase3-testnet-v3-deployment.json'), `${JSON.stringify(deploymentManifest, null, 2)}\n`);
console.log(`Compiled V3 Relay (${finalRelay.evm.deployedBytecode.object.length / 2} runtime bytes) for checkpoint ${checkpoint.height}.`);
console.log(`V3 Relay runtime hash: ${relayRuntimeHash}`);
console.log(`Compiled V3 Gateway (${gatewayCompiled.evm.deployedBytecode.object.length / 2} runtime bytes) reusing four deployed verifiers.`);
console.log('Nothing was deployed and no transaction was broadcast.');
