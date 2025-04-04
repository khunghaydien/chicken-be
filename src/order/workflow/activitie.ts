
import { PaymentService } from '../../payment/payment.service';
import { InventoryService } from '../../inventory/inventory.service';
import { OrderStatus, PaymentStatus } from '@prisma/client'; // Import enums từ Prisma
import { PrismaService } from 'prisma/prisma.service';
import { NotificationService } from 'src/notification/notification.service';

// Định nghĩa custom errors để Temporal có thể xử lý non-retryable
export class PaymentFailedError extends Error { constructor(message = 'Payment Failed') { super(message); this.name = 'PaymentFailedError'; } }
export class InsufficientStockError extends Error { constructor(message = 'Insufficient Stock') { super(message); this.name = 'InsufficientStockError'; } }

export interface OrderActivitie {
  createPendingOrder(data: { userId: string; userEmail: string; totalAmount: number; items: { productId: string; quantity: number; priceAtOrder: number }[] }): Promise<{ orderId: string }>;
  updateOrderStatus(orderId: string, status: OrderStatus): Promise<void>;
  chargePayment(orderId: string, amount: number): Promise<{ transactionId: string; paymentRecordId: string }>;
  validateAndDecreaseInventory(orderId: string, items: { productId: string; quantity: number }[]): Promise<void>;
  notifyKitchen(orderId: string, items: { productId: string; quantity: number; name?: string }[]): Promise<void>; // Thêm tên sp cho dễ nhìn
  sendConfirmationEmail(orderId: string, userEmail: string): Promise<void>;
  refundPayment(paymentRecordId: string): Promise<void>; // Hoàn tiền dựa trên ID record thanh toán
  restoreInventory(orderId: string, items: { productId: string; quantity: number }[]): Promise<void>; // Compensation cho inventory
  sendFailureEmail(orderId: string, userEmail: string, reason: string): Promise<void>;
}

export function createOrderActivities(
  prisma: PrismaService,
  paymentService: PaymentService,
  inventoryService: InventoryService,
  notificationService: NotificationService,
): OrderActivitie {
  return {
    async createPendingOrder(data) {
        console.log('[Activity] Creating Pending Order in DB...');
        // Dùng transaction để tạo Order và OrderItems cùng lúc
        const order = await prisma.order.create({
            data: {
                userId: data.userId,
                userEmail: data.userEmail,
                totalAmount: data.totalAmount,
                status: OrderStatus.PENDING,
                items: {
                    create: data.items.map(item => ({
                        productId: item.productId,
                        quantity: item.quantity,
                        priceAtOrder: item.priceAtOrder,
                    })),
                },
            },
        });
        console.log(`[Activity] Pending Order created with ID: ${order.id}`);
        return { orderId: order.id };
    },

    async updateOrderStatus(orderId, status) {
      console.log(`[Activity] Updating Order ${orderId} status to ${status}`);
      await prisma.order.update({ where: { id: orderId }, data: { status } });
      console.log(`[Activity] Order ${orderId} status updated.`);
    },

    async chargePayment(orderId, amount) {
      console.log(`[Activity] Attempting payment for Order ${orderId}, Amount: ${amount}`);
      // Tạo record giao dịch PENDING trước khi gọi service
      const paymentRecord = await prisma.paymentTransaction.create({
          data: { orderId, amount, status: PaymentStatus.PENDING }
      });
      console.log(`[Activity] Created pending payment record: ${paymentRecord.id}`);
      try {
          const paymentResult = await paymentService.charge(orderId, amount); // Gọi mock service
          // Update record thành công
          await prisma.paymentTransaction.update({
              where: { id: paymentRecord.id },
              data: { status: PaymentStatus.SUCCEEDED, externalTransactionId: paymentResult.transactionId }
          });
          console.log(`[Activity] Payment SUCCEEDED for Order ${orderId}. TxID: ${paymentResult.transactionId}, RecordID: ${paymentRecord.id}`);
          return { transactionId: paymentResult.transactionId, paymentRecordId: paymentRecord.id };
      } catch (error) {
          console.error(`[Activity] Payment FAILED for Order ${orderId}`, error);
          // Update record thất bại
          await prisma.paymentTransaction.update({
              where: { id: paymentRecord.id },
              data: { status: PaymentStatus.FAILED }
          });
          // Ném lỗi cụ thể để Temporal xử lý
          if (error.name === 'PaymentFailedError' || error instanceof PaymentFailedError) {
             throw error; // Ném lại lỗi gốc nếu là lỗi đã biết
          }
          throw new PaymentFailedError(`Payment failed for order ${orderId}: ${error.message}`);
      }
    },

    async validateAndDecreaseInventory(orderId, items) {
      console.log(`[Activity] Validating and Decreasing Inventory for Order ${orderId}`);
      try {
          await inventoryService.decreaseStock(items); // Service này sẽ throw InsufficientStockError nếu thất bại
          console.log(`[Activity] Inventory decreased successfully for Order ${orderId}`);
      } catch (error) {
          console.error(`[Activity] Inventory operation FAILED for Order ${orderId}`, error);
           if (error.name === 'InsufficientStockError' || error instanceof InsufficientStockError) {
              throw error; // Ném lại lỗi gốc
           }
           throw new InsufficientStockError(`Inventory check failed for order ${orderId}: ${error.message}`);
      }
    },

    async notifyKitchen(orderId, items) {
      console.log(`[Activity] Notifying Kitchen for Order ${orderId}`);
      // Lấy thêm tên sản phẩm cho dễ nhìn (tùy chọn)
      const productIds = items.map(i => i.productId);
      const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } });
      const productMap = new Map(products.map(p => [p.id, p.name]));
      const itemsWithNames = items.map(i => ({ ...i, name: productMap.get(i.productId) ?? 'Unknown Product' }));

      await notificationService.notifyKitchen(orderId, itemsWithNames);
      console.log(`[Activity] Kitchen notified for Order ${orderId}`);
    },

    async sendConfirmationEmail(orderId, userEmail) {
      console.log(`[Activity] Sending Confirmation Email for Order ${orderId} to ${userEmail}`);
      await notificationService.sendOrderConfirmationEmail(userEmail, orderId);
      console.log(`[Activity] Confirmation Email sent for Order ${orderId}`);
    },

    // --- Compensation Activities ---
    async refundPayment(paymentRecordId) {
      console.warn(`[Activity] Initiating REFUND for Payment Record ${paymentRecordId}`);
      // Cập nhật trạng thái thanh toán là đang refund
       await prisma.paymentTransaction.update({
          where: { id: paymentRecordId },
          data: { status: PaymentStatus.REFUND_INITIATED }
       });
      try {
          await paymentService.refund(paymentRecordId); // Gọi service refund (dùng paymentRecordId để tìm giao dịch cần refund)
          // Cập nhật trạng thái thành công
          await prisma.paymentTransaction.update({
               where: { id: paymentRecordId },
               data: { status: PaymentStatus.REFUNDED }
          });
          console.warn(`[Activity] REFUND successful for Payment Record ${paymentRecordId}`);
      } catch (error) {
          console.error(`[Activity] REFUND FAILED for Payment Record ${paymentRecordId}`, error);
           // Cập nhật trạng thái thất bại -> CẦN CAN THIỆP THỦ CÔNG
           await prisma.paymentTransaction.update({
               where: { id: paymentRecordId },
               data: { status: PaymentStatus.REFUND_FAILED }
           });
           // Ném lỗi để workflow biết refund thất bại (có thể cần xử lý đặc biệt trong workflow)
           throw new Error(`Failed to refund payment record ${paymentRecordId}: ${error.message}`);
      }
    },

    async restoreInventory(orderId, items) {
      console.warn(`[Activity] Restoring Inventory for Order ${orderId} due to failure/refund.`);
      try {
          await inventoryService.increaseStock(items);
          console.warn(`[Activity] Inventory restored successfully for Order ${orderId}`);
      } catch (error) {
          console.error(`[Activity] Failed to restore inventory for Order ${orderId}`, error);
           // Lỗi nghiêm trọng, cần log và cảnh báo
           throw new Error(`Failed to restore inventory for order ${orderId}: ${error.message}`);
      }
    },

    async sendFailureEmail(orderId, userEmail, reason) {
         console.log(`[Activity] Sending Failure Email for Order ${orderId} to ${userEmail}. Reason: ${reason}`);
         await notificationService.sendOrderFailedEmail(userEmail, orderId, reason);
         console.log(`[Activity] Failure Email sent for Order ${orderId}`);
     },
  };
}