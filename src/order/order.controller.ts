import { Controller, Post, Body, Get, Param, HttpCode, HttpStatus, UsePipes, ValidationPipe } from '@nestjs/common';
import { OrderService } from './order.service';
import { CreateOrderDto } from './dto/create-order.dto';

@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) // Validate DTO
  @HttpCode(HttpStatus.ACCEPTED) // Trả về 202 Accepted vì xử lý là bất đồng bộ
  async createOrder(@Body() createOrderDto: CreateOrderDto) {
    return this.orderService.createOrder(createOrderDto);
  }

   // Endpoint ví dụ để xem status từ DB (đơn giản hơn Query Temporal)
   @Get(':id/status')
   async getOrderStatus(@Param('id') orderId: string) {
       // Lưu ý: 'id' ở đây là orderId từ DB
       return this.orderService.getOrderStatusFromDb(orderId);
   }

   // Endpoint ví dụ để xem status từ Temporal Workflow (nếu bạn implement Query)
   // @Get('workflow/:workflowId/status')
   // async getWorkflowStatus(@Param('workflowId') workflowId: string) {
   //     return this.orderService.getWorkflowStatus(workflowId);
   // }
}