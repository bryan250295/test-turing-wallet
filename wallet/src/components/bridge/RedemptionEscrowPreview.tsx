import type { BridgeOrder } from '../../../../shared/src/types/learningBridge';
import type { WalletSession } from '../../types/wallet';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import EscrowDeployments from './EscrowDeployments';

interface Props { order: BridgeOrder; session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; active: boolean }
export default function RedemptionEscrowPreview({ order, session, evm, active }: Props) {
	return <EscrowDeployments order={order} session={session} evm={evm} active={active} />;
}
