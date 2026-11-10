import { Inject, Injectable } from '@nestjs/common';
import type { ProofBridgeV3Snapshot } from '../../../shared/src/types/proofBridgeV3';
import { ProofBridgeV3Repository } from './proof-bridge-v3.repository';

type Listener = (snapshot: ProofBridgeV3Snapshot) => void;

@Injectable()
export class ProofBridgeV3ProgressService {
	private readonly listeners = new Map<string, Set<Listener>>();
	private relayer: ProofBridgeV3Snapshot['relayer'] = { mode: 'observe-only', address: null, balanceWei: null };
	constructor(@Inject(ProofBridgeV3Repository) private readonly repository: ProofBridgeV3Repository) {}

	setRelayer(value: ProofBridgeV3Snapshot['relayer']) { this.relayer = value; }
	info() { return this.relayer; }

	async snapshot(identityId: string) { return this.repository.snapshot(identityId, this.relayer); }

	async publish(identityId: string) {
		const subscribers = this.listeners.get(identityId);
		if (!subscribers?.size) return;
		const snapshot = await this.snapshot(identityId);
		for (const listener of subscribers) listener(snapshot);
	}

	subscribe(identityId: string, listener: Listener) {
		let subscribers = this.listeners.get(identityId);
		if (!subscribers) { subscribers = new Set(); this.listeners.set(identityId, subscribers); }
		subscribers.add(listener);
		void this.snapshot(identityId).then(listener);
		return () => {
			const current = this.listeners.get(identityId); current?.delete(listener);
			if (!current?.size) this.listeners.delete(identityId);
		};
	}
}
