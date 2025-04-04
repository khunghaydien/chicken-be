import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { InsufficientStockError } from 'src/order/workflow/activitie';
// Kiểu dữ liệu cho item cần cập nhật kho
interface StockUpdateItem {
  productId: string;
  quantity: number;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Giảm số lượng tồn kho cho một hoặc nhiều sản phẩm.
   * Hoạt động này được thực hiện trong một transaction để đảm bảo tính nguyên tử:
   * hoặc tất cả các sản phẩm được giảm kho thành công, hoặc không sản phẩm nào bị giảm.
   * Kiểm tra số lượng tồn kho trước khi giảm.
   *
   * @param items Danh sách các sản phẩm và số lượng cần giảm.
   * @throws InsufficientStockError Nếu bất kỳ sản phẩm nào không đủ số lượng tồn kho.
   * @throws InternalServerErrorException Nếu có lỗi cơ sở dữ liệu không mong muốn.
   */
  async decreaseStock(items: StockUpdateItem[]): Promise<void> {
    if (!items || items.length === 0) {
      this.logger.warn('decreaseStock called with empty items array. Skipping.');
      return;
    }

    const productIds = items.map(item => item.productId);
    this.logger.log(`Attempting to decrease stock for Product IDs: [${productIds.join(', ')}]`);

    try {
      // Sử dụng transaction của Prisma để đảm bảo tất cả cập nhật thành công hoặc rollback
      await this.prisma.$transaction(async (tx) => {
        // Sử dụng Promise.all để thực hiện các cập nhật song song bên trong transaction
        await Promise.all(items.map(async (item) => {
          if (item.quantity <= 0) {
            this.logger.warn(`Skipping stock decrease for Product ID: ${item.productId} due to non-positive quantity: ${item.quantity}`);
            return; // Bỏ qua nếu số lượng không hợp lệ
          }

          this.logger.debug(`Processing decrease for Product ID: ${item.productId}, Quantity: ${item.quantity}`);

          // Cập nhật và kiểm tra trong một thao tác duy nhất bằng `updateMany` với điều kiện `where`
          // `updateMany` trả về { count: number } - số lượng bản ghi đã được cập nhật
          const result = await tx.inventoryItem.updateMany({
            where: {
              productId: item.productId,
              quantity: {
                gte: item.quantity, // Chỉ cập nhật nếu số lượng hiện tại >= số lượng cần giảm
              },
            },
            data: {
              quantity: {
                decrement: item.quantity, // Giảm số lượng đi `item.quantity`
              },
            },
          });

          // Kiểm tra kết quả: Nếu count = 0, nghĩa là điều kiện where không khớp
          // (hoặc không tìm thấy productId, hoặc quantity < item.quantity)
          if (result.count === 0) {
            // Thử kiểm tra xem sản phẩm có tồn tại không để cung cấp lỗi rõ ràng hơn
            const exists = await tx.inventoryItem.findUnique({
                where: { productId: item.productId },
                select: { quantity: true } // Chỉ lấy quantity để kiểm tra
            });

            let reason = `Product ID: ${item.productId} not found in inventory.`;
            if (exists) {
                 reason = `Insufficient stock for Product ID: ${item.productId}. Required: ${item.quantity}, Available: ${exists.quantity}.`;
            }

            this.logger.error(`Failed to decrease stock: ${reason}`);
            // Ném lỗi cụ thể -> Transaction sẽ tự động rollback
            throw new InsufficientStockError(reason);
          }

          this.logger.debug(`Successfully decreased stock for Product ID: ${item.productId} by ${item.quantity}. Records updated: ${result.count}`);
        }));
        // Nếu tất cả Promise trong Promise.all hoàn thành mà không ném lỗi, transaction sẽ commit
      });

      this.logger.log(`Successfully decreased stock for all requested items. Product IDs: [${productIds.join(', ')}]`);

    } catch (error) {
      // Bắt lỗi từ bên trong transaction (đặc biệt là InsufficientStockError)
      if (error instanceof InsufficientStockError) {
        this.logger.error(`Stock decrease failed due to insufficient stock: ${error.message}`);
        throw error; // Ném lại lỗi cụ thể để activity biết
      } else {
        // Bắt các lỗi khác (ví dụ: lỗi kết nối DB,...)
        this.logger.error(`An unexpected error occurred during stock decrease transaction for Product IDs: [${productIds.join(', ')}]`, error.stack);
        throw new InternalServerErrorException('An unexpected error occurred while updating inventory.');
      }
    }
  }

  /**
   * Tăng số lượng tồn kho cho một hoặc nhiều sản phẩm.
   * Thường được sử dụng cho việc bồi thường (compensation) khi đơn hàng bị hủy/hoàn tiền
   * sau khi đã giảm kho.
   * Hoạt động này cũng được thực hiện trong một transaction.
   *
   * @param items Danh sách các sản phẩm và số lượng cần tăng.
   * @throws InternalServerErrorException Nếu có lỗi cơ sở dữ liệu không mong muốn.
   */
  async increaseStock(items: StockUpdateItem[]): Promise<void> {
    if (!items || items.length === 0) {
      this.logger.warn('increaseStock called with empty items array. Skipping.');
      return;
    }

    const productIds = items.map(item => item.productId);
    this.logger.warn(`Attempting to RESTORE stock (increase) for Product IDs: [${productIds.join(', ')}]`);

    try {
      // Sử dụng transaction để đảm bảo tính nhất quán
      await this.prisma.$transaction(async (tx) => {
        await Promise.all(items.map(async (item) => {
           if (item.quantity <= 0) {
               this.logger.warn(`Skipping stock increase for Product ID: ${item.productId} due to non-positive quantity: ${item.quantity}`);
               return; // Bỏ qua nếu số lượng không hợp lệ
           }

          this.logger.debug(`Processing increase for Product ID: ${item.productId}, Quantity: ${item.quantity}`);

          // Tăng số lượng tồn kho
          const result = await tx.inventoryItem.updateMany({
            where: {
              productId: item.productId,
            },
            data: {
              quantity: {
                increment: item.quantity, // Tăng số lượng lên `item.quantity`
              },
            },
          });

          // Kiểm tra xem sản phẩm có tồn tại để tăng không
          if (result.count === 0) {
            // Đây là trường hợp lạ khi compensation: sản phẩm đã bị xóa khỏi inventory?
            // Ghi log cảnh báo thay vì ném lỗi để không làm gián đoạn workflow compensation
            this.logger.error(`Failed to increase stock for Product ID: ${item.productId}. Product not found in inventory during compensation. Records updated: ${result.count}`);
            // KHÔNG ném lỗi ở đây để compensation có thể tiếp tục các bước khác nếu có
          } else {
             this.logger.debug(`Successfully increased stock for Product ID: ${item.productId} by ${item.quantity}. Records updated: ${result.count}`);
          }
        }));
      });

       this.logger.warn(`Successfully RESTORED stock (increase) for requested items. Product IDs: [${productIds.join(', ')}]`);

    } catch (error) {
       // Bắt các lỗi không mong muốn từ transaction
       this.logger.error(`An unexpected error occurred during stock increase (compensation) transaction for Product IDs: [${productIds.join(', ')}]`, error.stack);
       // Ném lỗi để activity compensation biết là đã thất bại
       throw new InternalServerErrorException('An unexpected error occurred while restoring inventory.');
    }
  }

   /**
    * (Hàm phụ trợ - tùy chọn) Lấy số lượng tồn kho hiện tại của một sản phẩm.
    * Có thể hữu ích cho việc kiểm tra hoặc hiển thị.
    *
    * @param productId ID của sản phẩm cần kiểm tra.
    * @returns Số lượng tồn kho hoặc null nếu không tìm thấy sản phẩm.
    */
   async getStockQuantity(productId: string): Promise<number | null> {
       try {
           const inventoryItem = await this.prisma.inventoryItem.findUnique({
               where: { productId: productId },
               select: { quantity: true },
           });
           return inventoryItem?.quantity ?? null; // Trả về null nếu không tìm thấy
       } catch (error) {
            this.logger.error(`Error fetching stock quantity for Product ID: ${productId}`, error.stack);
            // Có thể ném lỗi hoặc trả về một giá trị đặc biệt tùy logic gọi
            throw new InternalServerErrorException('Failed to fetch stock quantity.');
       }
   }

}