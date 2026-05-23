import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';

export class CreateVenueBookingDto {
  @IsUUID()
  venueId!: string;

  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;

  @IsInt()
  @Min(1)
  expectedAttendance!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  eventType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  /**
   * Negotiated venue revenue share percentage.
   * Pattern enforces NUMERIC(19,4) string format e.g. "30.0000".
   * This value is immutable once the VenueBooking reaches ACCEPTED.
   */
  @Matches(/^\d+\.\d{4}$/, {
    message: 'venueRevenueSharePercentage must be a decimal string with 4 decimal places e.g. "30.0000"',
  })
  venueRevenueSharePercentage!: string;
}
