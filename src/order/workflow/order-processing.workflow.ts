import * as wf from '@temporalio/workflow';
import { OrderStatus } from '@prisma/client'; // Dùng lại enum
import { OrderActivitie, PaymentFailedError, InsufficientStockError } from './activitie'; // Import interface và errors

// Proxy Activities với cấu hình Retry và Timeout
const {
    createPendingOrder,
    updateOrderStatus,
    chargePayment,
    validateAndDecreaseInventory,
    notifyKitchen,
    sendConfirmationEmail,
} = wf.proxyActivities<OrderActivitie>({
  startToCloseTimeout: '1 minute', // Timeout cho mỗi lần thử activity
  heartbeatTimeout: '30 seconds', // Gửi heartbeat nếu activity chạy lâu
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumAttempts: 5,
    // QUAN TRỌNG: Không retry các lỗi nghiệp vụ không thể tự khắc phục
    nonRetryableErrorTypes: ['PaymentFailedError', 'InsufficientStockError'],
  },
});

// Compensation Activities (thường cần timeout dài hơn và retry mạnh hơn)
 const {
     refundPayment: refundPaymentCompensation,
     restoreInventory: restoreInventoryCompensation,
     updateOrderStatus: updateOrderStatusCompensation,
     sendFailureEmail: sendFailureEmailCompensation,
 } = wf.proxyActivities<Pick<OrderActivitie, 'refundPayment' | 'restoreInventory' | 'updateOrderStatus' | 'sendFailureEmail'>>({
     startToCloseTimeout: '5 minutes', // Timeout dài hơn cho compensation
     retry: {
         initialInterval: '5 seconds',
         backoffCoefficient: 2,
         maximumAttempts: 10, // Cố gắng retry nhiều hơn
         // Không retry lỗi nghiệp vụ nếu có
          // nonRetryableErrorTypes: ['RefundSystemDownError']
     },
 });


// Input của Workflow
export interface OrderProcessingWorkflowInput {
  userId: string;
  userEmail: string;
  items: { productId: string; quantity: number; priceAtOrder: number; name?: string }[]; // Thêm giá và tên lúc đặt hàng
  totalAmount: number;
}

// Workflow chính
export async function processOrderWorkflow(input: OrderProcessingWorkflowInput): Promise<{ orderId: string; finalStatus: OrderStatus }> {
  const { userId, userEmail, items, totalAmount } = input;
  let orderId: string | null = null;
  let paymentRecordId: string | null = null;
  let inventoryUpdated = false;
  let finalStatus: OrderStatus = OrderStatus.PENDING; // Trạng thái cuối cùng
  let failureReason = 'Unknown Workflow Failure';

  try {
      // 1. Tạo Order PENDING trong DB (Activity đầu tiên)
      // Activity này quan trọng để có orderId ngay lập tức
      wf.log.info('Workflow: Creating pending order record...');
      const { orderId: newOrderId } = await createPendingOrder({ userId, userEmail, totalAmount, items });
      orderId = newOrderId;
      wf.log.info(`Workflow: Pending order created with ID: ${orderId}. Updating status to PROCESSING.`);
      await updateOrderStatus(orderId, OrderStatus.PROCESSING); // Cập nhật trạng thái
      finalStatus = OrderStatus.PROCESSING;

      // === Cập nhật workflowId vào Order ===
      // Cách 1: Dùng Signal (từ bên ngoài gọi vào sau khi start workflow)
      // Cách 2: Dùng activity riêng (an toàn hơn)
       // async function updateWorkflowIdActivity(orderId: string, workflowId: string): Promise<void> { ... }
       // await updateWorkflowIdActivity(orderId, wf.info.workflowId);

      // 2. Thu tiền
      wf.log.info(`Workflow: Attempting payment for order ${orderId}`);
      const paymentResult = await chargePayment(orderId, totalAmount);
      paymentRecordId = paymentResult.paymentRecordId; // Lưu ID record thanh toán
      wf.log.info(`Workflow: Payment successful for order ${orderId}. PaymentRecordID: ${paymentRecordId}. Updating status to PAID.`);
      await updateOrderStatus(orderId, OrderStatus.PAID);
      finalStatus = OrderStatus.PAID;

      // 3. Kiểm tra và Trừ kho
      wf.log.info(`Workflow: Validating and decreasing inventory for order ${orderId}`);
      await validateAndDecreaseInventory(orderId, items.map(i => ({ productId: i.productId, quantity: i.quantity })));
      inventoryUpdated = true; // Đánh dấu đã trừ kho
      wf.log.info(`Workflow: Inventory updated for order ${orderId}. Updating status to AWAITING_FULFILLMENT.`);
      await updateOrderStatus(orderId, OrderStatus.AWAITING_FULFILLMENT);
      finalStatus = OrderStatus.AWAITING_FULFILLMENT;

      // 4. Thông báo Bếp chuẩn bị hàng
      wf.log.info(`Workflow: Notifying kitchen for order ${orderId}`);
      await notifyKitchen(orderId, items.map(i => ({ productId: i.productId, quantity: i.quantity, name: i.name })));
      wf.log.info(`Workflow: Kitchen notified for order ${orderId}`);
      // Có thể thêm status FULFILLMENT_IN_PROGRESS nếu cần

      // 5. Gửi Email xác nhận
      wf.log.info(`Workflow: Sending confirmation email for order ${orderId}`);
      await sendConfirmationEmail(orderId, userEmail);
      wf.log.info(`Workflow: Confirmation email sent for order ${orderId}. Updating status to COMPLETED.`);
      // Coi như hoàn thành khi email đã gửi
      await updateOrderStatus(orderId, OrderStatus.COMPLETED);
      finalStatus = OrderStatus.COMPLETED;

      wf.log.info(`Workflow for order ${orderId} completed successfully.`);
      return { orderId, finalStatus };

  } catch (err) {
      wf.log.error(`Workflow failed for order ${orderId ?? 'UNKNOWN'}. Error:`, err);

      // Xác định trạng thái lỗi dựa trên lỗi gốc
      if (err instanceof wf.ActivityFailure) {
          const cause = err.cause; // Lỗi gốc từ activity
          if (cause instanceof PaymentFailedError || (cause && cause.name === 'PaymentFailedError')) {
              finalStatus = OrderStatus.PAYMENT_FAILED;
              failureReason = 'Payment was declined or failed.';
          } else if (cause instanceof InsufficientStockError || (cause && cause.name === 'InsufficientStockError')) {
              finalStatus = OrderStatus.INVENTORY_CHECK_FAILED;
              failureReason = 'One or more items are out of stock.';
          } else {
              // Lỗi không xác định từ activity (vd: timeout, lỗi kết nối)
              finalStatus = OrderStatus.CANCELLED; // Hoặc một trạng thái lỗi chung khác
               failureReason = `Activity execution failed: ${cause?.message ?? err.message}`;
          }
      } else if (err instanceof wf.CancelledFailure) {
           finalStatus = OrderStatus.CANCELLED;
           failureReason = 'Workflow was cancelled.';
      } else {
          // Lỗi workflow khác (vd: lỗi code workflow, Terminated)
          finalStatus = OrderStatus.CANCELLED; // Hoặc FAILED
          failureReason = `Workflow execution error: ${err.message}`;
      }

      // --- Thực hiện Compensation ---
      // Chỉ chạy compensation nếu đã có orderId
      if (orderId) {
           wf.log.warn(`Workflow compensation starting for order ${orderId}. Final Status: ${finalStatus}`);
           try {
               // A. Hoàn tiền nếu đã thanh toán thành công
               if (paymentRecordId) {
                   wf.log.warn(`Compensation: Refunding payment for record ${paymentRecordId}`);
                   await refundPaymentCompensation(paymentRecordId);
                   // Nếu refund thành công, có thể cập nhật status thành REFUNDED
                   // Nếu không, finalStatus vẫn là trạng thái lỗi ban đầu
                   // await updateOrderStatusCompensation(orderId, OrderStatus.REFUNDED); // Cập nhật lại nếu refund OK
                   wf.log.warn(`Compensation: Refund attempt finished for record ${paymentRecordId}`);
               }

               // B. Trả lại hàng vào kho nếu đã trừ kho
               if (inventoryUpdated) {
                   wf.log.warn(`Compensation: Restoring inventory for order ${orderId}`);
                   await restoreInventoryCompensation(orderId, items.map(i => ({ productId: i.productId, quantity: i.quantity })));
                   wf.log.warn(`Compensation: Inventory restore attempt finished for order ${orderId}`);
               }

               // C. Cập nhật trạng thái cuối cùng sau compensation (dùng activity compensation)
               wf.log.warn(`Compensation: Updating final order status to ${finalStatus}`);
               await updateOrderStatusCompensation(orderId, finalStatus);

               // D. Gửi email thông báo lỗi cho khách hàng
               wf.log.warn(`Compensation: Sending failure email to ${userEmail}`);
               await sendFailureEmailCompensation(orderId, userEmail, failureReason);

           } catch (compensationError) {
               // LỖI NGHIÊM TRỌNG: Compensation thất bại! Cần cảnh báo gấp!
               wf.log.error(`CRITICAL: Workflow compensation FAILED for order ${orderId}! Manual intervention required.`, compensationError);
               // Có thể cập nhật trạng thái thành một trạng thái đặc biệt như 'COMPENSATION_FAILED'
               // await updateOrderStatusCompensation(orderId, OrderStatus.COMPENSATION_FAILED); // Ví dụ
               // Hoặc ném lỗi để workflow kết thúc với trạng thái FAILED và log lỗi compensation
                throw new Error(`Compensation failed after initial error: ${compensationError.message}. Original error: ${err.message}`);
           }
           wf.log.warn(`Workflow compensation finished for order ${orderId}.`);

      } else {
          wf.log.error('Workflow failed before an Order ID could be established. No compensation possible.');
           // Không có orderId, không thể làm gì thêm trong workflow này
      }

      // Trả về lỗi và trạng thái cuối cùng
      // Không ném lại lỗi ở đây nếu đã xử lý compensation và muốn workflow kết thúc bình thường (với trạng thái FAILED/CANCELLED)
      // Nếu muốn Temporal ghi nhận là FAILED thì phải throw err;
      // throw err;
      return { orderId: orderId ?? 'N/A', finalStatus };
  }
}