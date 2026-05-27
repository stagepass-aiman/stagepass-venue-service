import { IsString, MaxLength } from 'class-validator';

export class RejectVenueBookingDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}
