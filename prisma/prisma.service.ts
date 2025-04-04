import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    async onModuleInit() {
        // Kết nối đến database khi module khởi tạo
        await this.$connect();
        console.log('Prisma connected to database.');
    }
    async onModuleDestroy() {
        // Đóng kết nối khi ứng dụng tắt
        await this.$disconnect();
        console.log('Prisma disconnected.');
    }
}