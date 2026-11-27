import { Inject, Injectable } from '@nestjs/common';
import { defer, filter, interval, map, merge, of, Subject, switchMap, type Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import type { Principal } from '../auth/auth.service';
import { BridgeSettlementRepository } from './bridge-settlement.repository';

export interface ProgressInvalidation {
	identityId: string;
	orderId: string;
	reason: string;
	at: string;
}

type ProgressListener = (update: ProgressInvalidation) => void;

@Injectable()
export class BridgeProgressService {
	private readonly updates = new Subject<ProgressInvalidation>();
	constructor(@Inject(BridgeSettlementRepository) private readonly repository: BridgeSettlementRepository) {}

	publish(identityId: string, orderId: string, reason: string) {
		this.updates.next({ identityId, orderId, reason, at: new Date().toISOString() });
	}

	subscribe(identityId: string, listener: ProgressListener) {
		const subscription = this.updates.subscribe((update) => {
			if (update.identityId === identityId) listener(update);
		});
		return () => subscription.unsubscribe();
	}

	stream(orderId: string, principal: Principal): Observable<MessageEvent> {
		const event = (data: object, type = 'progress'): MessageEvent => ({ type, data: JSON.stringify(data) });
		return defer(() => this.repository.owned(orderId, principal.id)).pipe(
			switchMap(() => merge(
				of(event({ orderId, at: new Date().toISOString() }, 'ready')),
				this.updates.pipe(
					filter((update) => update.identityId === principal.id && update.orderId === orderId),
					map((update) => event(update)),
				),
				interval(25_000).pipe(map(() => event({ orderId, at: new Date().toISOString() }, 'heartbeat'))),
			)),
		);
	}
}
