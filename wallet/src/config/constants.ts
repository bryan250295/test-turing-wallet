

// Shared by the browser app and Vite server. Keep this file free of browser globals.
export const DEVNET_DOMAIN = 'api.tbcdev.org';
export const DEVNET_API_BASE = `https://${DEVNET_DOMAIN}/api/tbc`;
export const BITBUS_API_BASE = 'https://api.bitbus.net';
export const HTLC_INSPECTION_BATCH_LIMIT = 25;

export const BITBUS_API_URLS = {
	health: `${BITBUS_API_BASE}/health`,
	assets: (offset = 0, limit = 100) => `${BITBUS_API_BASE}/assets?offset=${offset}&limit=${limit}`,
	tradingPairs: (offset = 0, limit = 100) => `${BITBUS_API_BASE}/trading-pairs?offset=${offset}&limit=${limit}`,
};

export const API_URLS = {
	htlcSecretChallenge: '/__htlc/secret/challenge',
	htlcSecretRetrieve: '/__htlc/secret/retrieve',
	htlcHistory: '/__htlc/locks',
	htlcWalletStatus: '/__htlc/locks/status',
	nodeInfo: `${DEVNET_API_BASE}/nodeinfo`,
	unsignedTokenHtlc: '/__htlc/token/unsigned',
	tokenHtlcSigningRequest: '/__htlc/token/signing-request',
	finalizeTokenHtlc: '/__htlc/token/finalize',
	broadcastTokenHtlc: '/__htlc/token/broadcast',
	inspectTokenHtlc: '/__htlc/token/inspect',
	settleTokenHtlc: '/__htlc/token/settle',
	scriptUtxos: (hash: string) => `${DEVNET_API_BASE}/utxo/scriptpubkeyhash/${encodeURIComponent(hash)}`,
	contractTokenUtxos: (hash: string, contractId: string) => `${DEVNET_API_BASE}/ft/utxo/combinescript/${encodeURIComponent(hash)}01/contract/${encodeURIComponent(contractId)}`,
	testnetBroadcast: `${DEVNET_API_BASE}/broadcasttx`,
	rawTransaction: (txid: string) => `${DEVNET_API_BASE}/txraw/txid/${encodeURIComponent(txid)}`,
	actionLog: '/__wallet-log',
	tokenTransaction: (txid: string) =>
		`${DEVNET_API_BASE}/ft/decode/txid/${encodeURIComponent(txid)}`,
	tokenInfo: (contractId: string) =>
		`${DEVNET_API_BASE}/ft/info/contract/${encodeURIComponent(contractId)}`,
	nativeHistory: (address: string, start: number, end: number) =>
		`${DEVNET_API_BASE}/history/address/${encodeURIComponent(address)}/start/${start}/end/${end}`,
	tokenHistory: (address: string, start: number, end: number) =>
		`${DEVNET_API_BASE}/ft/allhistory/address/${encodeURIComponent(address)}/start/${start}/end/${end}`,
	transaction: (txid: string) =>
		`${DEVNET_API_BASE}/decode/txid/${encodeURIComponent(txid)}`,
	nativeUtxos: (address: string) =>
		`${DEVNET_API_BASE}/utxo/address/${encodeURIComponent(address)}`,
	tokenList: (address: string) =>
		`${DEVNET_API_BASE}/ft/tokenlist/address/${encodeURIComponent(address)}`,
	tokenUtxos: (address: string, contractId: string) =>
		`${DEVNET_API_BASE}/ft/utxo/address/${encodeURIComponent(address)}/contract/${encodeURIComponent(contractId)}`,
};
