import { defineConfig } from 'hardhat/config';

export default defineConfig({
	networks: {
		node: {
			type: 'edr-simulated',
			chainType: 'l1',
			chainId: 11155111,
			hardfork: 'cancun',
			blockGasLimit: 30_000_000,
			initialBaseFeePerGas: 0,
			throwOnTransactionFailures: false,
			throwOnCallFailures: true,
		},
	},
});
