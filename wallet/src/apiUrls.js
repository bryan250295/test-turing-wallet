// Shared by the browser app and Vite server. Keep this file free of browser globals.
export const DEVNET_DOMAIN = 'api.tbcdev.org';
export const DEVNET_API_BASE = `https://${DEVNET_DOMAIN}/api/tbc`;

export const API_URLS = {
	actionLog: '/__wallet-log',
	nativeHistory: (address, start, end) =>
		`${DEVNET_API_BASE}/history/address/${encodeURIComponent(address)}/start/${start}/end/${end}`,
	tokenHistory: (address, start, end) =>
		`${DEVNET_API_BASE}/ft/allhistory/address/${encodeURIComponent(address)}/start/${start}/end/${end}`,
	transaction: (txid) =>
		`${DEVNET_API_BASE}/decode/txid/${encodeURIComponent(txid)}`,
	nativeUtxos: (address) =>
		`${DEVNET_API_BASE}/utxo/address/${encodeURIComponent(address)}`,
	tokenList: (address) =>
		`${DEVNET_API_BASE}/ft/tokenlist/address/${encodeURIComponent(address)}`,
	tokenUtxos: (address, contractId) =>
		`${DEVNET_API_BASE}/ft/utxo/address/${encodeURIComponent(address)}/contract/${encodeURIComponent(contractId)}`,
};
