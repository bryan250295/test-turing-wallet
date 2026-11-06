import { Injectable } from '@nestjs/common';
import { preparePhase3TestnetRelayPlan } from './phase3/testnet-relay-plan';

@Injectable()
export class Phase3TestnetRelayService {
	prepare(from: string) {
		return preparePhase3TestnetRelayPlan(from);
	}
}
