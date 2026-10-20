import { useEffect, useState } from 'react';

import { getNativeUtxos, getTokens, getTokenUtxos } from './tbcApi';

export default function UtxoPage({ address, networkIsDevnet }) {
	const [refresh, setRefresh] = useState(0);
	const [state, setState] = useState({ loading: true, groups: [], errors: [] });

	useEffect(() => {
		const controller = new AbortController();
		const { signal } = controller;
		setState({ loading: true, groups: [], errors: [] });
		if (!address || !networkIsDevnet) return () => controller.abort();

		async function load() {
			const groups = [];
			const errors = [];
			const results = await Promise.allSettled([
				getNativeUtxos(address, { signal }),
				getTokens(address, { signal }),
			]);
			if (results[0].status === 'fulfilled') {
				groups.push({ id: 'native', name: 'Native TBC', outputs: results[0].value });
			} else errors.push(`Native TBC: ${results[0].reason.message}`);
			if (results[1].status === 'fulfilled') {
				const tokens = results[1].value;
				// Fetch token groups in sequence to avoid flooding the public API.
				for (const token of tokens) {
					if (signal.aborted) return;
					try {
						const outputs = await getTokenUtxos(address, token.contract_id, { signal });
						groups.push({ id: token.contract_id, name: token.name || token.symbol || 'Unnamed token', symbol: token.symbol, outputs });
					} catch (error) {
						errors.push(`${token.name || token.contract_id}: ${error.message}`);
					}
				}
			} else errors.push(`Token list: ${results[1].reason.message}`);
			if (!signal.aborted) setState({ loading: false, groups, errors });
		}
		load().catch((error) => {
			if (!signal.aborted) setState({ loading: false, groups: [], errors: [error.message] });
		});
		return () => controller.abort();
	}, [address, networkIsDevnet, refresh]);

	if (!address || !networkIsDevnet) return <p className="status">Connect your wallet on TBC Devnet to view unspent outputs.</p>;
	const count = state.groups.reduce((total, group) => total + group.outputs.length, 0);

	return <section className="utxo-panel" aria-labelledby="utxo-heading" aria-busy={state.loading}>
		<div className="utxo-heading">
			<h2 id="utxo-heading">Unspent outputs</h2>
			<button type="button" disabled={state.loading} onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
		</div>
		<p className="status" role="status">{state.loading ? 'Loading native TBC and token UTXOs…' : `${count} outputs loaded${state.errors.length ? ' — some requests failed; list is incomplete.' : '.'}`}</p>
		<p>Native TBC and fungible tokens for this address. Amounts are shown in raw units. NFTs and other contract types are not included.</p>
		{state.errors.map((error, index) => <p className="result error" role="alert" key={index}>{error}</p>)}
		{state.groups.map((group) => <section className="utxo-group" key={group.id}>
			<h3>{group.name}{group.symbol ? ` (${group.symbol})` : ''} · {group.outputs.length} UTXOs</h3>
			{group.id !== 'native' && <p>Contract: <code>{group.id}</code></p>}
			{!group.outputs.length && <p>No unspent outputs.</p>}
			{group.outputs.map((output) => <dl className="utxo-output" key={`${output.txid}:${output.index}`}>
				<div><dt>TXID</dt><dd><code>{output.txid}</code></dd></div>
				<div><dt>Output index</dt><dd>{output.index}</dd></div>
				<div><dt>{group.id === 'native' ? 'TBC amount (satoshis)' : 'Token amount (raw units)'}</dt><dd>{String(group.id === 'native' ? output.value ?? output.satoshis ?? '—' : output.ft_value ?? '—')}</dd></div>
				{group.id !== 'native' && <>
					<div><dt>Decimals</dt><dd>{output.decimal ?? '—'}</dd></div>
					<div><dt>Attached TBC (satoshis)</dt><dd>{String(output.tbc_value ?? '—')}</dd></div>
				</>}
				<div><dt>Block height</dt><dd>{output.height === -1 ? 'Unconfirmed' : output.height ?? 'Unknown'}</dd></div>
			</dl>)}
		</section>)}
	</section>;
}
