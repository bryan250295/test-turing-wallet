import { useEffect, useRef, useState } from 'react';

interface Options {
	context: string;
	enabled: boolean;
	waiting: boolean;
	busy: boolean;
	error: string;
	check: () => Promise<unknown>;
}
/** Only receive observation callbacks. Never pass a quote, sign, send or broadcast action. */
export default function useConfirmationPolling(options: Options) {
	const [automatic, setAutomatic] = useState(true);
	const latest = useRef(options); latest.current = options;
	useEffect(() => {
		if (!automatic || !options.enabled || !options.waiting) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		const schedule = () => { if (!cancelled) timer = setTimeout(() => { void tick(); }, 30_000); };
		async function tick() {
			const current = latest.current;
			if (cancelled || current.context !== options.context || !current.enabled || !current.waiting) return;
			try {
				if (!current.busy && !current.error && document.visibilityState === 'visible') await current.check();
			} catch { /* The flow owns its error state; no transaction action is retried here. */ }
			finally { schedule(); }
		}
		schedule();
		return () => { cancelled = true; clearTimeout(timer); };
	}, [options.context, options.enabled, options.waiting, automatic]);
	return { automatic, setAutomatic, paused: !!options.error };
}
