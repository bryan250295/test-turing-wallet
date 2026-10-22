import type { WalletPageProps } from '../types/wallet';
import WalletConnection from '../components/WalletConnection';
import useUtxos from '../hooks/useUtxos';

export default function UtxoPage({ session }: WalletPageProps) {
	return (
		<section className="card">
			<p className="eyebrow">TBC TEST NETWORK ONLY</p>
			<h1>UTXO List</h1>
			<p className="intro">Inspect the unspent outputs holding your native TBC and tokens.</p>
			<WalletConnection session={session} />
			<p className="status" role="status">{session.status}</p>
			<UtxoList key={`${session.address}:${session.networkIsDevnet}`} address={session.address} networkIsDevnet={session.networkIsDevnet} />
		</section>
	);
}

function UtxoList({ address, networkIsDevnet }: { address: string; networkIsDevnet: boolean }) {
	const state = useUtxos(address, networkIsDevnet);

	if (!address || !networkIsDevnet) return <p className="status">Connect your wallet on TBC Devnet to view unspent outputs.</p>;
	const count = state.groups.reduce((total, group) => total + group.outputs.length, 0);

	return <section className="utxo-panel" aria-labelledby="utxo-heading" aria-busy={state.loading}>
		<div className="utxo-heading">
			<h2 id="utxo-heading">Unspent outputs</h2>
			<button type="button" disabled={state.loading} onClick={state.refresh}>Refresh</button>
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
