import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { keccak256 } from 'viem';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dependencyRoot = resolve(root, 'node_modules/@openzeppelin/contracts');
const sourceNames = [
    'contracts/phase3/TbcProofVerifier.sol',
    'contracts/phase3/TbcDifficultyVerifier.sol',
    'contracts/phase3/TbcBootstrapVerifier.sol',
    'contracts/phase3/TbcBootstrapVerifierV2.sol',
    'contracts/phase3/TbcHeaderRelayV2.sol',
    'contracts/phase3/TbcHeaderRelayTestnetV2.sol',
    'contracts/phase3/TbcHeaderRelayIntegrationHarness.sol',
    'contracts/phase3/TbcVerifierHarness.sol',
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
    'contracts/phase3/TbcProofMintGateway.sol',
    'contracts/phase3/TbcProofMintGatewayTestnetV2.sol',
    'contracts/phase3/TbcBridgeDepositVerifierHarness.sol',
    'contracts/phase3/TbcAuthorizedTransitionHarness.sol',
    'contracts/phase3/TbcFtUnlockPrefixHarness.sol',
    'contracts/phase3/TbcDepositReplayHarness.sol',
    'contracts/phase3/TbcProofMintIntegrationHarness.sol',
];
const sources = Object.fromEntries(await Promise.all(sourceNames.map(async (sourceName) => [
    sourceName,
    { content: await readFile(resolve(root, sourceName), 'utf8') },
])));

if (!solc.version().startsWith('0.8.30+')) throw new Error('Install the pinned Solidity compiler 0.8.30.');
const openzeppelin = JSON.parse(await readFile(resolve(dependencyRoot, 'package.json'), 'utf8'));
if (openzeppelin.version !== '5.4.0') throw new Error('Install the pinned OpenZeppelin Contracts 5.4.0.');

const input = {
    language: 'Solidity',
    sources,
    settings: {
        evmVersion: 'cancun',
        optimizer: { enabled: true, runs: 200 },
        outputSelection: {
            '*': {
                '': ['ast'],
                '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'metadata'],
            },
        },
    },
};
function readImport(path) {
    if (!path.startsWith('@openzeppelin/contracts/')) return { error: `Unsupported import: ${path}` };
    const resolved = resolve(root, 'node_modules', path);
    if (!resolved.startsWith(`${dependencyRoot}${sep}`)) return { error: `Import outside dependency: ${path}` };
    try {
        const content = readFileSync(resolved, 'utf8');
        sources[path] = { content };
        return { contents: content };
    } catch {
        return { error: `Cannot read import: ${path}` };
    }
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: readImport }));
for (const diagnostic of output.errors ?? []) console.error(diagnostic.formattedMessage);
if ((output.errors ?? []).some((entry) => entry.severity === 'error')) {
    throw new Error('Phase 3 contract compilation failed; no artifacts were written.');
}

const buildInput = { ...input, sources };
const buildInputSha256 = createHash('sha256').update(JSON.stringify(buildInput)).digest('hex');
function immutableNames(sourceName) {
    const names = {};
    function visit(value) {
        if (!value || typeof value !== 'object') return;
        if (value.nodeType === 'VariableDeclaration' && value.mutability === 'immutable') {
            names[value.id] = value.name;
        }
        for (const nested of Object.values(value)) {
            if (Array.isArray(nested)) nested.forEach(visit);
            else visit(nested);
        }
    }
    visit(output.sources?.[sourceName]?.ast);
    return names;
}
const artifactRoot = resolve(root, 'artifacts/phase3');
await mkdir(artifactRoot, { recursive: true });
const publicContractNames = new Set([
    'TbcBootstrapVerifierV2',
    'TbcHeaderRelayTestnetV2',
    'TbcAuthenticatedTransitionVerifier',
    'TbcInputSignatureVerifier',
    'TbcFinalizedDepositVerifier',
    'TbcFtUnlockPrefixVerifierModule',
    'TbcProofMintGatewayTestnetV2',
]);
for (const sourceName of sourceNames) {
    for (const [contractName, compiled] of Object.entries(output.contracts?.[sourceName] ?? {})) {
        if (!publicContractNames.has(contractName)) continue;
        const bytecode = compiled.evm?.bytecode?.object ?? '';
        const deployedBytecode = compiled.evm?.deployedBytecode?.object ?? '';
        const deployedByteLength = deployedBytecode.length / 2;
        if (deployedByteLength > 24_576) throw new Error(`${contractName} exceeds the EVM deployed code-size limit.`);
        const artifact = {
            contractName,
            sourceName,
            compilerVersion: solc.version(),
            targetChainId: 998,
            buildInputSha256,
            settings: input.settings,
            abi: compiled.abi,
            bytecode: `0x${bytecode}`,
            deployedBytecode: `0x${deployedBytecode}`,
            immutableReferences: compiled.evm?.deployedBytecode?.immutableReferences ?? {},
            immutableNames: immutableNames(sourceName),
            metadata: JSON.parse(compiled.metadata),
            buildInput,
        };
        await writeFile(resolve(artifactRoot, `${contractName}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
        console.log(`Compiled ${contractName} (${deployedByteLength} runtime bytes).`);
    }
}
const readArtifact = async (name) => JSON.parse(await readFile(resolve(artifactRoot, `${name}.json`), 'utf8'));
const finalizedArtifact = await readArtifact('TbcFinalizedDepositVerifier');
const transitionArtifact = await readArtifact('TbcAuthenticatedTransitionVerifier');
const signatureArtifact = await readArtifact('TbcInputSignatureVerifier');
const prefixArtifact = await readArtifact('TbcFtUnlockPrefixVerifierModule');
const gatewayArtifact = await readArtifact('TbcProofMintGatewayTestnetV2');
const relayArtifact = await readArtifact('TbcHeaderRelayTestnetV2');
const deploymentManifest = {
    schema: 'learningmaterials/phase3-public-testnet-v2-deployment/v1',
    chainId: 998,
    checkpoint: {
        height: 840039,
        hash: '0x000000000000005270e8447f4c71c6952ef28e40625fc58ddd38c027f5ef1cda',
        commitmentRoot: '0x471d082663e7ce837793ab0ea19606b3dd6ea66020708f29e9987519154337c5',
    },
    contracts: {
        finalized: {
            contractName: finalizedArtifact.contractName,
            bytecode: finalizedArtifact.bytecode,
            runtimeCodeHash: keccak256(finalizedArtifact.deployedBytecode),
        },
        transition: {
            contractName: transitionArtifact.contractName,
            bytecode: transitionArtifact.bytecode,
            runtimeCodeHash: keccak256(transitionArtifact.deployedBytecode),
        },
        signature: {
            contractName: signatureArtifact.contractName,
            bytecode: signatureArtifact.bytecode,
            runtimeCodeHash: keccak256(signatureArtifact.deployedBytecode),
        },
        prefix: {
            contractName: prefixArtifact.contractName,
            bytecode: prefixArtifact.bytecode,
            runtimeCodeHash: keccak256(prefixArtifact.deployedBytecode),
        },
        gateway: {
            contractName: gatewayArtifact.contractName,
            bytecode: gatewayArtifact.bytecode,
            creationCodeHash: keccak256(gatewayArtifact.bytecode),
        },
        relay: {
            contractName: relayArtifact.contractName,
            bytecode: relayArtifact.bytecode,
            runtimeCodeHash: keccak256(relayArtifact.deployedBytecode),
        },
    },
};
const generatedRoot = resolve(root, 'src/generated');
await mkdir(generatedRoot, { recursive: true });
await writeFile(
    resolve(generatedRoot, 'phase3-testnet-v2-deployment.json'),
    `${JSON.stringify(deploymentManifest, null, 2)}\n`,
);
console.log('Public Testnet-v2 artifacts target Cancun / HyperEVM Testnet 998. Nothing was deployed or submitted.');

