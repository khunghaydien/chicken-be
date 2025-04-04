
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PaymentFailedError } from 'src/order/workflow/activitie';
import { PrismaService } from 'prisma/prisma.service';
// Import lỗi non-retryable từ activities để service có thể ném ra đúng loại lỗi

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mô phỏng việc gọi cổng thanh toán để thu tiền cho một đơn hàng.
   * Tạo một bản ghi giao dịch trước, sau đó mô phỏng lệnh gọi API.
   * Cập nhật trạng thái bản ghi giao dịch dựa trên kết quả mô phỏng.
   *
   * @param orderId ID của đơn hàng cần thanh toán.
   * @param amount Số tiền cần thanh toán.
   * @returns Promise chứa ID giao dịch giả lập bên ngoài và ID bản ghi giao dịch trong DB.
   * @throws PaymentFailedError Nếu thanh toán mô phỏng thất bại (lỗi nghiệp vụ).
   * @throws InternalServerErrorException Nếu có lỗi DB nghiêm trọng.
   */
  async charge(orderId: string, amount: number): Promise<{ transactionId: string; paymentRecordId: string }> {
    this.logger.log(`Initiating mock payment charge for Order ID: ${orderId}, Amount: ${amount}`);

    // 1. Tạo bản ghi giao dịch với trạng thái PENDING
    let paymentRecord;
    try {
      paymentRecord = await this.prisma.paymentTransaction.create({
        data: {
          orderId: orderId,
          amount: amount,
          status: PaymentStatus.PENDING,
        },
      });
      this.logger.log(`Created PENDING PaymentTransaction record ID: ${paymentRecord.id} for Order ID: ${orderId}`);
    } catch (dbError) {
      this.logger.error(`Failed to create PENDING PaymentTransaction for Order ID: ${orderId}`, dbError.stack);
      // Không thể tiếp tục nếu không tạo được bản ghi
      throw new InternalServerErrorException('Database error occurred while initiating payment transaction.');
    }

    // --- Bắt đầu mô phỏng gọi API cổng thanh toán ---
    const mockExternalTxId = `MOCK_TX_${uuidv4().toUpperCase()}`;
    const isPaymentSuccessful = Math.random() > 0.15; // 85% tỷ lệ thành công giả lập

    this.logger.debug(`Simulating external payment call for Record ID: ${paymentRecord.id}... Success chance: ${isPaymentSuccessful}`);
    // Giả lập độ trễ mạng
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1500 + 500)); // 0.5s - 2s delay
    // --- Kết thúc mô phỏng ---

    // 3. Xử lý kết quả mô phỏng và cập nhật DB
    if (isPaymentSuccessful) {
      try {
        await this.prisma.paymentTransaction.update({
          where: { id: paymentRecord.id },
          data: {
            status: PaymentStatus.SUCCEEDED,
            externalTransactionId: mockExternalTxId, // Lưu ID giả lập
          },
        });
        this.logger.log(`Mock payment SUCCEEDED for Record ID: ${paymentRecord.id}. External TxID: ${mockExternalTxId}`);
        return {
          transactionId: mockExternalTxId,
          paymentRecordId: paymentRecord.id,
        };
      } catch (dbError) {
        this.logger.error(`Failed to update PaymentTransaction to SUCCEEDED for Record ID: ${paymentRecord.id}`, dbError.stack);
        // Đây là trường hợp khó xử: Thanh toán thành công nhưng DB lỗi.
        // Cần cơ chế đối soát hoặc cảnh báo. Trong ví dụ này, ta vẫn coi là lỗi server.
        throw new InternalServerErrorException('Database error occurred after successful mock payment.');
      }
    } else {
      // Thanh toán mô phỏng thất bại
      this.logger.warn(`Mock payment FAILED for Record ID: ${paymentRecord.id}`);
      try {
        await this.prisma.paymentTransaction.update({
          where: { id: paymentRecord.id },
          data: { status: PaymentStatus.FAILED },
        });
        this.logger.warn(`Updated PaymentTransaction status to FAILED for Record ID: ${paymentRecord.id}`);
      } catch (dbError) {
        this.logger.error(`Failed to update PaymentTransaction to FAILED for Record ID: ${paymentRecord.id}`, dbError.stack);
        // Vẫn ưu tiên ném lỗi thanh toán gốc
      }
      // Ném lỗi cụ thể để Temporal Activity biết đây là lỗi nghiệp vụ không nên retry
      throw new PaymentFailedError(`Mock payment gateway declined the transaction for Order ID: ${orderId}`);
    }
  }

  /**
   * Mô phỏng việc gọi cổng thanh toán để hoàn tiền cho một giao dịch đã thành công trước đó.
   *
   * @param paymentRecordId ID của bản ghi PaymentTransaction (trong DB) cần hoàn tiền.
   * @returns Promise<void>
   * @throws Error Nếu không tìm thấy giao dịch, giao dịch không ở trạng thái có thể hoàn tiền, hoặc hoàn tiền mô phỏng thất bại.
   */
  async refund(paymentRecordId: string): Promise<void> {
    this.logger.warn(`Initiating mock payment refund for Payment Record ID: ${paymentRecordId}`);

    // 1. Tìm giao dịch gốc trong DB
    let transaction;
    try {
        transaction = await this.prisma.paymentTransaction.findUnique({
            where: { id: paymentRecordId },
        });
    } catch(dbError) {
         this.logger.error(`Database error while fetching PaymentTransaction ID: ${paymentRecordId} for refund`, dbError.stack);
         throw new InternalServerErrorException('Database error occurred while fetching transaction for refund.');
    }


    if (!transaction) {
      this.logger.error(`Refund failed: Payment Record ID ${paymentRecordId} not found.`);
      throw new Error(`Payment transaction record ${paymentRecordId} not found.`);
    }

    // 2. Kiểm tra trạng thái có thể hoàn tiền (ví dụ: chỉ hoàn tiền giao dịch đã SUCCEEDED)
    // Có thể mở rộng để cho phép retry refund nếu trạng thái là REFUND_FAILED hoặc REFUND_INITIATED
    if (transaction.status !== PaymentStatus.SUCCEEDED) {
      this.logger.warn(`Refund skipped: Payment Record ID ${paymentRecordId} is not in SUCCEEDED state (current: ${transaction.status}). No action taken.`);
      // Không ném lỗi, chỉ bỏ qua nếu trạng thái không phù hợp
      return;
    }

    // 3. Cập nhật trạng thái sang REFUND_INITIATED trước khi gọi API giả lập
    try {
        await this.prisma.paymentTransaction.update({
            where: { id: paymentRecordId },
            data: { status: PaymentStatus.REFUND_INITIATED },
        });
         this.logger.log(`Updated PaymentTransaction status to REFUND_INITIATED for Record ID: ${paymentRecordId}`);
    } catch(dbError) {
         this.logger.error(`Failed to update status to REFUND_INITIATED for Record ID: ${paymentRecordId}`, dbError.stack);
         throw new InternalServerErrorException('Database error occurred while initiating refund status.');
    }


    // --- Bắt đầu mô phỏng gọi API hoàn tiền ---
    const isRefundSuccessful = Math.random() > 0.05; // 95% tỷ lệ thành công giả lập

    this.logger.debug(`Simulating external payment refund call for Record ID: ${paymentRecordId}... Success chance: ${isRefundSuccessful}`);
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 300)); // 0.3s - 1.3s delay
    // --- Kết thúc mô phỏng ---

    // 4. Xử lý kết quả hoàn tiền mô phỏng
    if (isRefundSuccessful) {
      try {
        await this.prisma.paymentTransaction.update({
          where: { id: paymentRecordId },
          data: { status: PaymentStatus.REFUNDED },
        });
        this.logger.warn(`Mock refund SUCCEEDED for Payment Record ID: ${paymentRecordId}. Status updated to REFUNDED.`);
      } catch (dbError) {
        this.logger.error(`Failed to update PaymentTransaction to REFUNDED for Record ID: ${paymentRecordId} after successful mock refund`, dbError.stack);
        // Lỗi DB sau khi refund thành công -> Cần cảnh báo/đối soát
         throw new InternalServerErrorException('Database error occurred after successful mock refund.');
      }
    } else {
      // Hoàn tiền mô phỏng thất bại
      this.logger.error(`Mock refund FAILED for Payment Record ID: ${paymentRecordId}`);
      try {
        await this.prisma.paymentTransaction.update({
          where: { id: paymentRecordId },
          data: { status: PaymentStatus.REFUND_FAILED }, // Đánh dấu là hoàn tiền thất bại
        });
         this.logger.error(`Updated PaymentTransaction status to REFUND_FAILED for Record ID: ${paymentRecordId}`);
      } catch (dbError) {
         this.logger.error(`Failed to update PaymentTransaction to REFUND_FAILED for Record ID: ${paymentRecordId}`, dbError.stack);
          // Vẫn ưu tiên ném lỗi refund gốc
      }
      // Ném lỗi để Temporal Activity (Compensation) biết là đã thất bại
      throw new Error(`Mock payment gateway failed to process refund for Transaction Record ID: ${paymentRecordId}`);
    }
  }
}