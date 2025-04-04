import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from 'prisma/prisma.module';
import { TemporalModule } from './temporal/temporal.constant';
import { ConfigModule } from '@nestjs/config';
import { OrderModule } from './order/order.module';
import { ProductModule } from './product/product.module';
import { InventoryModule } from './inventory/inventory.module';
import { PaymentModule } from './payment/payment.module';
import { NotificationModule } from './notification/notification.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, TemporalModule, OrderModule, ProductModule, InventoryModule, PaymentModule, NotificationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
