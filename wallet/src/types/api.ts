

// Numeric API amounts may be strings to preserve integer precision.
export type Amount = string | number;
export type ApiObject = Record<string, unknown>;

export interface Token extends ApiObject {
	contract_id: string;
	name?: string;
	symbol?: string;
	decimal?: Amount;
	balance?: Amount;
}

export interface Utxo extends ApiObject {
	txid: string;
	index: number;
	value?: Amount;
	satoshis?: Amount;
	ft_value?: Amount;
	tbc_value?: Amount;
	decimal?: Amount;
	height?: number;
}

export interface TransactionEntry extends ApiObject {
	address?: string;
	balance?: Amount;
	value?: Amount;
}

export interface TransactionData extends ApiObject {
	contract_id?: string;
	decimal?: Amount;
	confirmations?: number;
	height?: number;
	time?: number;
	fee?: Amount;
	input?: TransactionEntry[];
	output?: TransactionEntry[];
	vin?: TransactionEntry[];
	vout?: TransactionEntry[];
}

export interface HistoryRecord extends TransactionData {
	txid: string;
}

export interface Health extends ApiObject {
	status: string;
}

export interface Asset extends ApiObject {
	id: string;
	name?: string;
	symbol?: string;
	chain?: string;
	decimals?: Amount;
}

export interface TradingPair extends ApiObject {
	id: string;
	base_asset?: Asset | null;
	quote_asset?: Asset | null;
	is_active?: boolean;
}
