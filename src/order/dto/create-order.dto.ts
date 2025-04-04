import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsNumber, IsString, Min, ValidateNested } from 'class-validator';

class OrderItemDto {
  @IsString()
  @IsNotEmpty()
  productId: string;

  @IsNumber()
  @Min(1)
  quantity: number;
}

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  userId: string; // Lấy từ auth context thực tế

  @IsString() // Nên validate email đúng định dạng
  @IsNotEmpty()
  userEmail: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  // Có thể thêm paymentMethodNonce nếu cần cho payment service
  // @IsString()
  // paymentMethodNonce?: string;
}