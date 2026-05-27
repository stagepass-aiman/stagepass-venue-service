import { IsDateString, IsString, MaxLength } from 'class-validator';

export class CreateUnavailabilityDto {
  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;

  @IsString()
  @MaxLength(500)
  reason!: string;
}
