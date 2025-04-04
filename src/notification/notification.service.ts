import { Injectable, Logger } from '@nestjs/common';

// Định nghĩa một kiểu dữ liệu đơn giản cho item để truyền vào kitchen
interface KitchenItem {
  productId: string;
  quantity: number;
  name?: string; // Tên sản phẩm (tùy chọn nhưng hữu ích)
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  /**
   * Mô phỏng việc gửi thông tin đơn hàng đến hệ thống hiển thị của bếp.
   * @param orderId ID của đơn hàng.
   * @param items Danh sách các món hàng cần chuẩn bị.
   */
  async notifyKitchen(orderId: string, items: KitchenItem[]): Promise<void> {
    this.logger.log(`🍳 Notifying Kitchen for Order ID: ${orderId}`);

    if (!items || items.length === 0) {
      this.logger.warn(`No items provided for kitchen notification, Order ID: ${orderId}`);
      return; // Không có gì để thông báo
    }

    // Định dạng lại danh sách item cho dễ đọc trong log
    const formattedItems = items.map(item =>
      `  - ${item.quantity}x ${item.name || `Product(${item.productId})`}` // Hiển thị tên nếu có, nếu không thì ID
    ).join('\n'); // Mỗi item một dòng

    // --- Bắt đầu Mô phỏng gọi API/Hệ thống Bếp ---
    console.log("================ KITCHEN ORDER ================");
    console.log(` ORDER ID: ${orderId}`);
    console.log(" Items to Prepare:");
    console.log(formattedItems);
    console.log("=============================================");
    // Giả lập độ trễ
    await new Promise(resolve => setTimeout(resolve, 300)); // 300ms delay giả lập
    // --- Kết thúc Mô phỏng ---

    // Giả sử luôn thành công trong bản mock này
    this.logger.log(`✅ Successfully notified Kitchen for Order ID: ${orderId}`);
    // Trong thực tế, ở đây có thể có try...catch để xử lý lỗi khi gọi API bếp
  }

  /**
   * Mô phỏng việc gửi email xác nhận đơn hàng thành công cho khách hàng.
   * @param email Địa chỉ email của khách hàng.
   * @param orderId ID của đơn hàng đã được xác nhận.
   */
  async sendOrderConfirmationEmail(email: string, orderId: string): Promise<void> {
    this.logger.log(`📧 Attempting to send Order Confirmation Email to: ${email} for Order ID: ${orderId}`);

    // --- Bắt đầu Mô phỏng gửi Email ---
    console.log("\n--- Sending Confirmation Email ---");
    console.log(`To: ${email}`);
    console.log(`Subject: ✅ Your Ga Ran Temporal Order Confirmation (#${orderId})`);
    console.log(`Body:`);
    console.log(` Hi there,`);
    console.log(` `);
    console.log(` Your delicious chicken order #${orderId} has been confirmed and is being prepared!`);
    console.log(` We'll notify you again when it's ready or shipped.`);
    console.log(` `);
    console.log(` Thanks for your order!`);
    console.log(` - The Ga Ran Temporal Team`);
    console.log("----------------------------------\n");
    // Giả lập độ trễ
    await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay giả lập
    // --- Kết thúc Mô phỏng ---

    // Giả sử luôn thành công
    this.logger.log(`✅ Successfully simulated sending confirmation email for Order ID: ${orderId} to ${email}`);
     // Trong thực tế, ở đây có thể có try...catch để xử lý lỗi khi gọi dịch vụ email (SendGrid, Mailgun, etc.)
  }

  /**
   * Mô phỏng việc gửi email thông báo lỗi/hủy đơn hàng cho khách hàng.
   * @param email Địa chỉ email của khách hàng.
   * @param orderId ID của đơn hàng bị lỗi/hủy.
   * @param reason Lý do đơn hàng thất bại (được truyền từ workflow).
   */
  async sendOrderFailedEmail(email: string, orderId: string, reason: string): Promise<void> {
    this.logger.warn(`🚨 Attempting to send Order Failure Email to: ${email} for Order ID: ${orderId}. Reason: ${reason}`);

     // --- Bắt đầu Mô phỏng gửi Email Lỗi ---
     console.log("\n--- Sending Order Failure Email ---");
     console.log(`To: ${email}`);
     console.log(`Subject: ⚠️ Issue with your Ga Ran Temporal Order (#${orderId})`);
     console.log(`Body:`);
     console.log(` Hi there,`);
     console.log(` `);
     console.log(` We're sorry, but there was an issue processing your order #${orderId}.`);
     console.log(` Reason: ${reason || 'An unexpected error occurred.'}`); // Hiển thị lý do
     console.log(` `);
     console.log(` If you were charged, a refund should be processed automatically (if applicable).`);
     console.log(` Please contact customer support if you have any questions.`);
     console.log(` `);
     console.log(` - The Ga Ran Temporal Team`);
     console.log("----------------------------------\n");
     // Giả lập độ trễ
     await new Promise(resolve => setTimeout(resolve, 400)); // 400ms delay giả lập
     // --- Kết thúc Mô phỏng ---

     // Giả sử luôn thành công
     this.logger.warn(`✅ Successfully simulated sending failure email for Order ID: ${orderId} to ${email}`);
     // Trong thực tế, ở đây có thể có try...catch
  }
}