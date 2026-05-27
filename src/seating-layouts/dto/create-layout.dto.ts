import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

class SeatDto {
  @IsString()
  seatId!: string;

  @IsString()
  row!: string;

  @IsString()
  number!: string;

  @IsEnum(['STANDARD', 'PREMIUM', 'ACCESSIBLE'])
  type!: 'STANDARD' | 'PREMIUM' | 'ACCESSIBLE';

  @IsNumber()
  svgX!: number;

  @IsNumber()
  svgY!: number;
}

class RowDto {
  @IsString()
  rowId!: string;

  @IsString()
  label!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SeatDto)
  @ArrayMinSize(1)
  seats!: SeatDto[];
}

class LayoutSectionDto {
  /** Stable section reference used by Event Service (e.g. "NORTH-STAND"). */
  @IsString()
  sectionRef!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  colour?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RowDto)
  @ArrayMinSize(1)
  rows!: RowDto[];
}

export class CreateLayoutDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LayoutSectionDto)
  @ArrayMinSize(1)
  sections!: LayoutSectionDto[];
}
