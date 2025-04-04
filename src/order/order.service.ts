import { Injectable, Inject, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { Client } from '@temporalio/client';
import { CreateOrderDto } from './dto/create-order.dto';
import { v4 as uuidv4 } from 'uuid';
import { Product } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { ORDER_PROCESSING_TASK_QUEUE, TEMPORAL_CLIENT } from 'src/temporal/temporal.constant';
import { OrderProcessingWorkflowInput, processOrderWorkflow } from './workflow/order-processing.workflow';

@Injectable()
export class OrderService {
  constructor(
    @Inject(TEMPORAL_CLIENT) private readonly temporalClient: Client,
    private readonly prisma: PrismaService,
    // Inject ProductService hoặc dùng trực tiếp Prisma ở đây
  ) {}

  async createOrder(createOrderDto: CreateOrderDto): Promise<{ submittedOrderId?: string; workflowId: string; message: string }> {
    const { userId, userEmail, items: itemDtos } = createOrderDto;

    // 1. Lấy thông tin sản phẩm và tính tổng tiền (quan trọng: lấy giá từ DB)
    const productIds = itemDtos.map((item) => item.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    if (products.length !== productIds.length) {
       const foundIds = new Set(products.map(p => p.id));
       const notFoundIds = productIds.filter(id => !foundIds.has(id));
      throw new NotFoundException(`Products not found: ${notFoundIds.join(', ')}`);
    }

    const productMap = new Map<string, Product>(products.map((p) => [p.id, p]));
    let totalAmount = 0;
    const workflowItems: OrderProcessingWorkflowInput['items'] = [];

    for (const itemDto of itemDtos) {
      const product = productMap.get(itemDto.productId);
      if (!product) {
         // Trường hợp này không nên xảy ra nếu logic trên đúng
         throw new InternalServerErrorException(`Product data inconsistent for ID: ${itemDto.productId}`);
      }
      const priceAtOrder = product.price; // Lấy giá hiện tại từ DB
      totalAmount += priceAtOrder * itemDto.quantity;
      workflowItems.push({
        productId: itemDto.productId,
        quantity: itemDto.quantity,
        priceAtOrder: priceAtOrder,
        name: product.name, // Truyền tên vào workflow cho dễ log/notify
      });
    }

    // 2. Chuẩn bị Input cho Workflow
    const workflowInput: OrderProcessingWorkflowInput = {
      userId,
      userEmail,
      items: workflowItems,
      totalAmount,
    };

    // 3. Tạo Workflow ID duy nhất (có thể dùng UUID hoặc kết hợp prefix)
    // Việc tạo Order record giờ sẽ nằm trong Activity đầu tiên của Workflow
    // Nhưng chúng ta cần một ID để start workflow
    const uniqueWorkflowIdSuffix = uuidv4();
    const workflowId = `order-wf-${uniqueWorkflowIdSuffix}`; // Đảm bảo unique

    try {
      // 4. Start Workflow
      console.log(`Service: Starting order processing workflow with ID: ${workflowId}`);
      const handle = await this.temporalClient.workflow.start(processOrderWorkflow, {
        taskQueue: ORDER_PROCESSING_TASK_QUEUE, // Sử dụng Task Queue đã định nghĩa
        workflowId: workflowId,                 // ID duy nhất cho lần chạy workflow này
        args: [workflowInput],                   // Truyền input vào hàm workflow
         // Cấu hình thêm nếu cần:
         // workflowExecutionTimeout: '10 minutes', // Timeout tổng thể
         // cronSchedule: '* * * * *', // Nếu là workflow định kỳ
         // memo: { customerId: userId }, // Dữ liệu không thay đổi, dùng để search
         // searchAttributes: { // Dữ liệu có thể thay đổi, dùng để search/filter
         //    CustomStringField: userId,
         //    CustomKeywordField: 'OnlineOrder'
         // }
      });
      console.log(`Service: Workflow ${handle.workflowId} started.`);

      // (Tùy chọn nâng cao): Ngay sau khi start, bạn có thể Signal workflow để gửi orderId DB vào
      // Hoặc tốt hơn là activity đầu tiên tạo order và trả về ID

      // Trả về workflowId để client có thể theo dõi nếu cần
      return {
        workflowId: handle.workflowId,
        message: 'Order processing initiated. You will receive an email confirmation shortly.',
        // submittedOrderId: undefined // OrderId sẽ được tạo trong workflow
      };

    } catch (error) {
       console.error(`Service: Failed to start workflow ${workflowId}`, error);
       // Có thể lỗi do Temporal Server không chạy, hoặc cấu hình sai
       throw new InternalServerErrorException('Failed to initiate order processing. Please try again later.');
    }
  }

   // (Tùy chọn) Lấy trạng thái từ DB
   async getOrderStatusFromDb(orderId: string) {
       const order = await this.prisma.order.findUnique({
           where: { id: orderId },
           select: { status: true, updatedAt: true } // Chỉ lấy các trường cần thiết
       });
       if (!order) {
           throw new NotFoundException(`Order with ID ${orderId} not found.`);
       }
       return order;
   }

   // (Tùy chọn) Lấy trạng thái từ Temporal Workflow (dùng Query)
   // async getWorkflowStatus(workflowId: string) {
   //     try {
   //         const handle = this.temporalClient.workflow.getHandle(workflowId);
   //         // Định nghĩa hàm query 'getStatus' trong workflow của bạn
   //         // const status = await handle.query<{ currentStatus: OrderStatus, step: string }>('getStatus');
   //         // return status;
   //         const description = await handle.describe();
   //         return description; // Trả về thông tin mô tả workflow
   //     } catch (error) {
   //          console.error(`Error querying workflow ${workflowId}:`, error);
   //          // Xử lý lỗi nếu workflow không tồn tại hoặc query thất bại
   //          if (error.type === 'WorkflowExecutionNotFound') {
   //              throw new NotFoundException(`Workflow with ID ${workflowId} not found.`);
   //          }
   //          throw new InternalServerErrorException('Failed to query workflow status.');
   //     }
   // }
}