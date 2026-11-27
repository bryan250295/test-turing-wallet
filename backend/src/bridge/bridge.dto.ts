import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, Equals, IsArray, IsBoolean, IsEthereumAddress, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class VerifyBridgeAssetDto {
	@ApiProperty({ type: String, description: 'The source FT Contract ID selected from the wallet.' })
	@IsString()
	@Matches(/^(?!0{64}$)[0-9a-f]{64}$/i)
	contractId!: string;
}

export class RegisterEthereumSepoliaFtRouteDto extends VerifyBridgeAssetDto {
	@ApiProperty({ type: String, description: 'Verified wrapped-token contract deployed on Ethereum Sepolia.' })
	@IsEthereumAddress()
	wrappedToken!: string;
	@ApiProperty({ type: String, description: 'Sepolia contract-creation transaction hash returned by MetaMask.' })
	@IsString()
	@Matches(/^0x(?!0{64}$)[0-9a-f]{64}$/i)
	txHash!: string;
}

export class PreviewBridgeDeploymentDto extends VerifyBridgeAssetDto {
	@ApiProperty({ type: Number, required: false, enum: [998], default: 998 })
	@IsOptional() @Equals(998)
	destinationChainId?: 998;
	@ApiProperty({ type: String, required: false, enum: ['multisig-relayer-v1.5'] })
	@IsOptional() @IsIn(['multisig-relayer-v1.5'])
	governanceMode?: 'multisig-relayer-v1.5';
	@ApiProperty({ type: String, required: false, maxLength: 64 })
	@IsOptional() @IsString() @Matches(/^[\x20-\x7e]{1,64}$/)
	wrappedName?: string;
	@ApiProperty({ type: String, required: false, maxLength: 11 })
	@IsOptional() @IsString() @Matches(/^[A-Za-z][A-Za-z0-9]{0,10}$/)
	wrappedSymbol?: string;
	@ApiProperty({ type: String, description: 'Public MetaMask account that would pay for deployment.' })
	@IsEthereumAddress()
	deployer!: string;
	@ApiProperty({ type: String, description: 'Public owner address for pause and minter management.' })
	@IsEthereumAddress()
	admin!: string;
	@ApiProperty({ type: String, description: 'Public address allowed to mint after verified deposits.' })
	@IsEthereumAddress()
	minter!: string;
}

export class SubmitBridgeDeploymentDto {
	@ApiProperty({ type: String, description: 'Deployment transaction hash returned by MetaMask on HyperEVM Testnet.' })
	@IsString()
	@Matches(/^0x(?!0{64}$)[0-9a-f]{64}$/i)
	txHash!: string;
}

export class PreviewV15MultisigDto {
	@ApiProperty({ type: String, description: 'Public MetaMask account paying the multisig deployment gas.' })
	@IsEthereumAddress()
	deployer!: string;
}

export class CheckV15MultisigDto {
	@ApiProperty({ type: String, description: 'Multisig contract-creation transaction hash returned by MetaMask.' })
	@IsString()
	@Matches(/^0x(?!0{64}$)[0-9a-f]{64}$/i)
	txHash!: string;
}

export class PreviewV15ActivationDto {
	@ApiProperty({ enum: ['propose', 'approve'] })
	@IsString() @IsIn(['propose', 'approve'])
	kind!: 'propose' | 'approve';
	@ApiProperty({ type: String, required: false, description: 'Required for the second approval.' })
	@IsOptional() @IsString() @Matches(/^0x(?!0{64}$)[0-9a-f]{64}$/i)
	actionId?: string;
}

export class CheckV15ActivationDto {
	@ApiProperty({ enum: ['propose', 'approve'] })
	@IsString() @IsIn(['propose', 'approve'])
	kind!: 'propose' | 'approve';
	@ApiProperty({ type: String, description: 'Deterministic multisig action ID.' })
	@IsString() @Matches(/^0x(?!0{64}$)[0-9a-f]{64}$/i)
	actionId!: string;
	@ApiProperty({ type: String, description: 'Transaction hash returned by MetaMask.' })
	@IsString() @Matches(/^0x(?!0{64}$)[0-9a-f]{64}$/i)
	txHash!: string;
}

export class PreparePhase3TestnetRelayDto {
	@ApiProperty({ type: String, description: 'Public HyperEVM Testnet account that would pay the relay gas.' })
	@IsEthereumAddress()
	from!: string;
}

export class BuildPhase3TestnetDepositDto {
	@ApiProperty({ type: String }) @Matches(/^[1-9A-HJ-NP-Za-km-z]{26,100}$/) sender!: string;
	@ApiProperty({ type: String }) @Matches(/^(?:02|03)[0-9a-f]{64}$|^04[0-9a-f]{128}$/i) publicKey!: string;
	@ApiProperty({ type: String }) @Matches(/^[0-9a-f]{64}$/i) contractId!: string;
	@ApiProperty({ type: String, example: '500000' }) @IsString() @MaxLength(278) @Matches(/^\d+(?:\.\d+)?$/) amount!: string;
	@ApiProperty({ type: String }) @IsEthereumAddress() recipient!: string;
}

export class Phase3TestnetDepositBuildDto {
	@ApiProperty({ type: String }) @IsUUID() buildId!: string;
}

export class FinalizePhase3TestnetDepositDto extends Phase3TestnetDepositBuildDto {
	@ApiProperty({ type: String }) @Matches(/^(?:02|03)[0-9a-f]{64}$|^04[0-9a-f]{128}$/i) publicKey!: string;
	@ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(6) @Matches(/^(?:[0-9a-f]{2}){9,80}$/i, { each: true }) signatures!: string[];
}

export class BroadcastPhase3TestnetDepositDto extends Phase3TestnetDepositBuildDto {
	@ApiProperty({ type: String }) @IsIn(['submit', 'check']) action!: 'submit' | 'check';
	@ApiProperty({ type: Boolean }) @IsBoolean() @Equals(true) confirmed!: true;
}

export class RegisterPhase3TestnetV3RouteDto {
	@ApiProperty({ type: String }) @IsEthereumAddress() deployer!: string;
	@ApiProperty({ type: String }) @IsEthereumAddress() relay!: string;
	@ApiProperty({ type: String }) @IsEthereumAddress() gateway!: string;
	@ApiProperty({ type: String }) @IsEthereumAddress() wrappedToken!: string;
	@ApiProperty({ type: String }) @Matches(/^0x(?!0{64}$)[0-9a-f]{64}$/i) relayTxHash!: string;
	@ApiProperty({ type: String }) @Matches(/^0x(?!0{64}$)[0-9a-f]{64}$/i) gatewayTxHash!: string;
}

export class PrepareBridgeOrderDto {
	@ApiProperty({ type: String, description: 'Stable request ID retained across retries of these exact terms.' })
	@IsUUID('4')
	idempotencyKey!: string;
	@ApiProperty({ type: String, description: 'A verified deployment belonging to the signed-in TBC identity.' })
	@IsUUID('4')
	deploymentId!: string;
	@ApiProperty({ type: String, example: '100.5' })
	@IsString()
	@MaxLength(278)
	@Matches(/^(0|[1-9]\d{0,19})(\.\d{1,255})?$/)
	amount!: string;
	@ApiProperty({ type: String, description: 'Nonzero HyperEVM receiving wallet; mixed-case checksums are verified.' })
	@IsEthereumAddress()
	recipient!: string;
}

export class CreateBridgeOrderDraftDto {
	@ApiProperty({ type: String, description: 'Stable request ID retained across retries of this route selection.' })
	@IsUUID('4')
	idempotencyKey!: string;
	@ApiProperty({ type: String, description: 'Verified source asset selected on TBC Testnet.' })
	@IsString() @Matches(/^(?!0{64}$)[0-9a-f]{64}$/i)
	contractId!: string;
	@ApiProperty({ type: Number, enum: [998, 11155111] })
	@IsIn([998, 11_155_111])
	destinationChainId!: 998 | 11_155_111;
}

export class FinalizeBridgeOrderDraftDto {
	@ApiProperty({ type: String, example: '100.5' })
	@IsString() @MaxLength(278) @Matches(/^(0|[1-9]\d{0,19})(\.\d{1,255})?$/)
	amount!: string;
	@ApiProperty({ type: String, description: 'Nonzero destination receiving wallet.' })
	@IsEthereumAddress()
	recipient!: string;
}
