import { useEffect, useRef, useState } from 'react';
import type { HtlcSecretPair } from '../types/htlc';
import { generateHtlcSecret, hashHtlcSecret } from '../utils/htlc';
import { getErrorMessage } from '../utils/errors';

export default function useHtlcSecret() {
	const [pair, setPair] = useState<HtlcSecretPair | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const generation = useRef(0);
	const pending = useRef(false);
	useEffect(() => () => { generation.current++; }, []);

	function clear() {
		generation.current++;
		pending.current = false;
		setPair(null);
		setBusy(false);
		setError('');
	}

	async function generate(): Promise<HtlcSecretPair | null> {
		if (pending.current) return null;
		pending.current = true;
		const version = ++generation.current;
		setBusy(true);
		setError('');
		setPair(null);
		try {
			const secretHex = generateHtlcSecret();
			const hashHex = await hashHtlcSecret(secretHex);
			if (version !== generation.current) return null;
			const result = { secretHex, hashHex };
			setPair(result);
			return result;
		} catch (cause) {
			if (version === generation.current) setError(getErrorMessage(cause));
			return null;
		} finally {
			if (version === generation.current) { pending.current = false; setBusy(false); }
		}
	}

	return { pair, busy, error, generate, clear };
}
