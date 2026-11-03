import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceNames = [
    'contracts/phase3/TbcProofVerifier.sol',
    'contracts/phase3/TbcDifficultyVerifier.sol',
    'contracts/phase3/TbcBootstrapVerifier.sol',
    'contracts/phase3/TbcHeaderRelayV2.sol',
    'contracts/phase3/TbcHeaderRelayIntegrationHarness.sol',
    'contracts/phase3/TbcVerifierHarness.sol',
    'contracts/phase3/TbcBoundedTransaction.sol',
    'contracts/phase3/TbcBridgeDepositVerifier.sol',
    'contracts/phase3/TbcBridgeDepositVerifierHarness.sol',
];
const sources = Object.fromEntries(await Promise.all(sourceNames.map(async (sourceName) => [
    sourceName,
    { content: await readFile(resolve(root, sourceName), 'utf8') },
])));

if (!solc.version().startsWith('0.8.30+')) throw new Error('Install the pinned Solidity compiler 0.8.30.');

const input = {
    language: 'Solidity',
    sources,
    settings: {
        evmVersion: 'cancun',
        optimizer: { enabled: true, runs: 200 },
        outputSelection: {
            '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] },
        },
    },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
for (const diagnostic of output.errors ?? []) console.error(diagnostic.formattedMessage);
if ((output.errors ?? []).some((entry) => entry.severity === 'error')) {
    throw new Error('Phase 3 contract compilation failed; no artifacts were written.');
}

const buildInputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
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
            metadata: JSON.parse(compiled.metadata),
            buildInput: input,
        };
        await writeFile(resolve(artifactRoot, `${contractName}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
        console.log(`Compiled ${contractName} (${deployedByteLength} runtime bytes).`);
    }
}
console.log('Phase 3 artifacts target Cancun / HyperEVM Testnet 998. Nothing was deployed or submitted.');
