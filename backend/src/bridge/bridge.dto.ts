import { ApiProperty } from '@nestjs/swagger';
import { IsEthereumAddress, IsString, IsUUID, Matches, IsOptional, Equals, MaxLength } from 'class-validator';

export class VerifyBridgeAssetDto {
	@ApiProperty({ type: String, description: 'The source FT Contract ID selected from the wallet.' })
	@IsString()
	@Matches(/^(?!0{64}$)[0-9a-f]{64}$/i)
	contractId!: string;
}

export class PreviewBridgeDeploymentDto extends VerifyBridgeAssetDto {
	@ApiProperty({ type: Number, required: false, enum: [998], default: 998 })
	@IsOptional() @Equals(998)
	destinationChainId?: 998;
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
