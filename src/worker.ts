import { NestFactory } from '@nestjs/core';
import { Worker, NativeConnection, Runtime, DefaultLogger } from '@temporalio/worker';
import { AppModule } from './app.module'; // Cần AppModule để lấy context DI
import { PaymentService } from './payment/payment.service';
import { InventoryService } from './inventory/inventory.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'prisma/prisma.service';
import { NotificationService } from './notification/notification.service';
import { createOrderActivities } from './order/workflow/activitie';
import { ORDER_PROCESSING_TASK_QUEUE } from './temporal/temporal.constant';

async function runWorker() {
  // Thiết lập logging cho Worker (ghi ra console)
   Runtime.install({ logger: new DefaultLogger('INFO') }); // Log level INFO hoặc DEBUG

  // Bootstrap NestJS application context để lấy DI container
  // KHÔNG chạy listen() ở đây
  const appContext = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'], // Log của NestJS context
  });
  console.log('NestJS context created for Temporal worker.');

  // Lấy các services cần thiết từ DI container
  const prismaService = appContext.get(PrismaService);
  const paymentService = appContext.get(PaymentService);
  const inventoryService = appContext.get(InventoryService);
  const notificationService = appContext.get(NotificationService);
  const configService = appContext.get(ConfigService); // Lấy ConfigService

  // Lấy địa chỉ Temporal Server từ config
  const temporalAddress = configService.get<string>('TEMPORAL_SERVER_ADDRESS', 'localhost:7233');
  const temporalNamespace = configService.get<string>('TEMPORAL_NAMESPACE', 'default');

  // Tạo kết nối riêng cho Worker (nên dùng NativeConnection)
  const connection = await NativeConnection.connect({
    address: temporalAddress,
  });
  console.log(`Worker connecting to Temporal at ${temporalAddress}, namespace: ${temporalNamespace}`);

  // Tạo Worker
  const worker = await Worker.create({
    connection: connection,
    namespace: temporalNamespace,
    taskQueue: ORDER_PROCESSING_TASK_QUEUE, // Phải khớp với taskQueue khi start workflow
    workflowsPath: require.resolve('./orders/workflows/order-processing.workflow'), // Chỉ định file workflow
    // Hoặc đăng ký tường minh: workflows: orderWorkflows, // Nếu export nhiều workflow từ file
    activities: createOrderActivities( // Inject dependencies vào activities factory
      prismaService,
      paymentService,
      inventoryService,
      notificationService
    ),
    // Cấu hình thêm cho worker nếu cần (số lượng activity/workflow chạy đồng thời, etc.)
     maxConcurrentActivityTaskExecutions: 100, // Mặc định
     maxConcurrentWorkflowTaskExecutions: 100, // Mặc định
  });

  console.log(`Worker started listening on task queue: "${ORDER_PROCESSING_TASK_QUEUE}"...`);

  // Bắt đầu chạy Worker (block process này)
  await worker.run();

  // Code dưới đây chỉ chạy khi worker bị shutdown
  console.log('Worker stopped.');
  await connection.close();
  console.log('Temporal connection closed.');
  await appContext.close();
  console.log('NestJS context closed.');
}

runWorker().catch((err) => {
  console.error('Worker failed to run:', err);
  Runtime.instance().shutdown(); // Đảm bảo runtime tắt hẳn
  process.exit(1);
});

// Xử lý tín hiệu shutdown (Ctrl+C)
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await Runtime.instance().shutdown();
    console.log('Temporal Runtime shutdown complete.');
    // Không cần gọi appContext.close() hay connection.close() nữa vì Runtime sẽ lo
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    await Runtime.instance().shutdown();
     console.log('Temporal Runtime shutdown complete.');
    process.exit(0);
});