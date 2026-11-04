import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dependencyRoot = resolve(root, 'node_modules/@openzeppelin/contracts');
const sourceNames = [
    'contracts/phase3/TbcProofVerifier.sol',
    'contracts/phase3/TbcDifficultyVerifier.sol',
    'contracts/phase3/TbcBootstrapVerifier.sol',
    'contracts/phase3/TbcHeaderRelayV2.sol',
    'contracts/phase3/TbcHeaderRelayIntegrationHarness.sol',
    'contracts/phase3/TbcVerifierHarness.sol',
    'contracts/phase3/TbcBoundedTransaction.sol',
    'contracts/phase3/TbcBridgeDepositVerifier.sol',
    'contracts/phase3/TbcInputAuthorization.sol',
    'contracts/phase3/TbcPartialSha256.sol',
    'contracts/phase3/TbcFtUnlockPrefixVerifier.sol',
    'contracts/phase3/TbcDepositReplayProtection.sol',
    'contracts/phase3/TbcAuthorizedTransitionVerifier.sol',
    'contracts/phase3/TbcFtUnlockPrefixVerifierModule.sol',
    'contracts/phase3/WrappedFTV2.sol',
    'contracts/phase3/TbcProofMintGateway.sol',
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
for (const sourceName of sourceNames) {
    for (const [contractName, compiled] of Object.entries(output.contracts?.[sourceName] ?? {})) {
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
console.log('Phase 3 artifacts target Cancun / HyperEVM Testnet 998. Nothing was deployed or submitted.');
