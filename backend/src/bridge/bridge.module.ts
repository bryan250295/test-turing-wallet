import { Module } from '@nestjs/common';
import { BridgeReconciliationController } from './bridge-reconciliation.controller';
import { BridgeReconciliationService } from './bridge-reconciliation.service';
import { BridgeReconciliationBalancesService } from './bridge-reconciliation-balances.service';
import { AuthModule } from '../auth/auth.module';
import { BridgeController } from './bridge.controller';
import { BridgeAssetVerifier } from './bridge-asset.verifier';
import { BridgeRepository } from './bridge.repository';
import { BridgeService } from './bridge.service';
import { BridgeDeploymentService } from './bridge-deployment.service';
import { BridgeDeploymentController } from './bridge-deployment.controller';
import { BridgeDeploymentsRepository } from './bridge-deployments.repository';
import { BridgeDeploymentVerifier } from './bridge-deployment-verifier';
import { BridgeDeploymentLifecycleService } from './bridge-deployment-lifecycle.service';
import { BridgeCustodyService } from './bridge-custody.service';
import { BridgeOrderTargetService } from './bridge-order-target.service';
import { BridgeOrdersRepository } from './bridge-orders.repository';
import { BridgeOrdersService } from './bridge-orders.service';
import { BridgeOrdersController } from './bridge-orders.controller';
import { BridgeSourcePaymentService } from './bridge-source-payment.service';
import { BridgeSettlementController } from './bridge-settlement.controller';
import { BridgeSettlementRepository } from './bridge-settlement.repository';
import { BridgeSettlementService } from './bridge-settlement.service';
import { BridgeDepositVerifier } from './bridge-deposit.verifier';
import { BridgeCallVerifier } from './bridge-call.verifier';
import { BridgeRedemptionController } from './bridge-redemption.controller';
import { BridgeRedemptionService } from './bridge-redemption.service';
import { RedemptionEscrowService } from './redemption-escrow.service';
import { RedemptionEscrowRepository } from './redemption-escrow.repository';
import { RedemptionOrdersService } from './redemption-orders.service';
import { RedemptionEscrowVerifier } from './redemption-escrow.verifier';

import { RedemptionWalletService } from './redemption-wallet.service';
import { RedemptionReleaseService } from './redemption-release.service';
import { RedemptionReleaseEngine } from './redemption-release.engine';
import { RedemptionLockVerifier } from './redemption-lock.verifier';

@Module({ imports: [AuthModule], controllers: [BridgeReconciliationController, BridgeController, BridgeDeploymentController, BridgeOrdersController, BridgeSettlementController, BridgeRedemptionController], providers: [BridgeSourcePaymentService, BridgeReconciliationService, BridgeReconciliationBalancesService, BridgeAssetVerifier, BridgeRepository, BridgeService, BridgeDeploymentService, BridgeDeploymentsRepository, BridgeDeploymentVerifier, BridgeDeploymentLifecycleService, BridgeCustodyService, BridgeOrderTargetService, BridgeOrdersRepository, BridgeOrdersService, BridgeSettlementRepository, BridgeSettlementService, BridgeDepositVerifier, BridgeCallVerifier, BridgeRedemptionService, RedemptionEscrowService, RedemptionEscrowRepository, RedemptionEscrowVerifier, RedemptionOrdersService, RedemptionReleaseService, RedemptionReleaseEngine, RedemptionLockVerifier, RedemptionWalletService], exports: [BridgeService] })
export class BridgeModule {}
