export const PHASE3_TESTNET_V3 = {
	version: 'testnet-v3',
	chainId: 998,
	checkpoint: {
		height: 840761,
		hash: '0x00000000000001323f160d35d5e0c6d2a90d98232f2cef53f2d4b629b8b2fdb4',
		bootstrapRoot: '0x7a96498fbbd2ce473770b7fd71aa49fc72f432c85355623048f9406d9565769b',
	},
	reserveController: '0x77fd918d8f6f221727f6e2dc282b47674dd741cd',
	relayRuntimeCodeHash: '0xa304f4e24311fa2178e29647e1f2afaa0d4096c448e1c475381dc3a5c5a60a8a',
	gatewayCreationCodeHash: '0x34adb3f3f859ac2a57d04e2cbe022ee99098c1699501f93ed038f65a543a39e9',
	gatewayCreationCodeBytes: 9236,
	modules: {
		finalized: '0x6b8fEd83821F49512A262D8AA0bb33D552a71B30',
		transition: '0x543b25082A8C71131b595398DBE59765aBac1045',
		signature: '0xC211aaBa219c0d31ba46b0eD3547FB22D7EFb6e1',
		prefix: '0x298b94b49c632dFBF90668b600514b69a63Cc5f7',
	},
} as const;
