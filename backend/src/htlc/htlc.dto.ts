import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
const txid = /^[0-9a-f]{64}$/i;
export class LockTermsDto {
	@ApiProperty({ type: String }) @IsString() @Length(26, 100) sender!: string;
	@ApiProperty({ type: String }) @IsString() @Length(26, 100) receiver!: string;
	@ApiProperty({ type: String }) @Matches(txid) contractId!: string;
	@ApiProperty({ type: String }) @IsString() @Length(1, 256) amount!: string;
	@ApiProperty({ type: String }) @Matches(txid) hashHex!: string;
	@ApiProperty({ type: String }) @IsString() @Length(1, 256) refundTime!: string;
}
export class BuildIdDto { @ApiProperty({ type: String }) @IsUUID() buildId!: string }
export class FinalizeDto extends BuildIdDto {
	@ApiProperty({ type: String }) @Matches(/^(?:02|03)[0-9a-f]{64}$|^04[0-9a-f]{128}$/i) publicKey!: string;
	@ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(6) @Matches(/^(?:[0-9a-f]{2}){9,80}$/i, { each: true }) signatures!: string[];
	@ApiProperty({ type: String, required: false }) @IsOptional() @Matches(txid) secretHex?: string;
}
export class BroadcastDto extends BuildIdDto {
	@ApiProperty({ type: String }) @IsIn(['submit', 'check']) action!: string;
	@ApiProperty({ type: Boolean }) @IsBoolean() @IsIn([true]) confirmed!: boolean;
}
export class InspectDto {
	@ApiProperty({ type: String }) @Matches(txid) lockTxid!: string;
	@ApiProperty({ type: String }) @Matches(txid) contractId!: string;
	@ApiProperty({ type: [String], required: false }) @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(txid, { each: true }) recoveryTxids?: string[];
}
export class SettleDto {
	@ApiProperty({ type: String }) @Matches(txid) lockTxid!: string;
	@ApiProperty({ type: String }) @Matches(txid) contractId!: string;
	@ApiProperty({ type: String }) @IsIn(['claim', 'refund']) action!: 'claim' | 'refund';
}
export class WalletStatusDto {
	@ApiProperty({ type: String }) @Matches(/^[1-9A-HJ-NP-Za-km-z]{26,100}$/) address!: string;
	@ApiProperty({ type: String, required: false }) @IsOptional() @Matches(txid) cursor?: string;
}
