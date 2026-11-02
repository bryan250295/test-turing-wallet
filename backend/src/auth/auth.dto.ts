import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsUUID, Length, MaxLength } from 'class-validator';

export class LoginChallengeDto {
	@ApiProperty({ type: String }) @IsIn(['tbc', 'evm']) chain!: 'tbc' | 'evm';
	@ApiProperty({ type: String }) @IsIn(['testnet', '998']) network!: 'testnet' | '998';
	@ApiProperty({ type: String }) @IsString() @Length(26, 100) address!: string;
}
export class VerifyLoginDto {
	@ApiProperty({ type: String }) @IsUUID() challengeId!: string;
	@ApiProperty({ type: String }) @IsString() @Length(1, 1024) signature!: string;
}
export class SecretChallengeDto {
	@ApiProperty({ type: String }) @IsString() @Length(64, 64) lockTxid!: string;
}
export class SecretVerifyDto extends VerifyLoginDto {}
export class ActionLogDto {
	@ApiProperty({ type: String }) @IsIn(['Connect', 'Mint', 'Transfer']) action!: string;
	@ApiProperty({ type: String }) @IsString() @MaxLength(100) outcome!: string;
}
