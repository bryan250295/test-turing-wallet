import type { Utxo } from './api';

export interface UtxoGroup {
	id: string;
	name: string;
	symbol?: string;
	outputs: Utxo[];
}
export interface UtxoState {
	loading: boolean;
	groups: UtxoGroup[];
	errors: string[];
}
