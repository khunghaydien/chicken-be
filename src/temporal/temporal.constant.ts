import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common"
import { Client, Connection } from "@temporalio/client"
import { ConfigModule, ConfigService } from '@nestjs/config';
export const TEMPORAL_CLIENT = Symbol('TEMPORAL_CLIENT')
export const ORDER_PROCESSING_TASK_QUEUE = 'order-processing-task-queue'

@Global()
@Module({
    imports: [ConfigModule.forRoot({ isGlobal: true })],
    providers: [{
        provide: TEMPORAL_CLIENT,
        useFactory: async (configService: ConfigService): Promise<Client> => {
            const connection = await Connection.connect({
                address: configService.get<string>('TEMPORAL_SERVER_ADDRESS') || 'localhost:7233',
            })
            const client = new Client({
                connection,
                namespace: configService.get<string>('TEMPORAL_NAMESPACE') || 'default',
            })
            console.log(`Temporal Client connected to namespace: ${client.options.namespace}`);
            return client
        },
        inject: [ConfigService], // Inject ConfigService
    }],
    exports: [TEMPORAL_CLIENT],
})

export class TemporalModule implements OnApplicationShutdown {
    constructor(@Inject(TEMPORAL_CLIENT) private readonly temporalClient: Client) { }
    async onApplicationShutdown(signal?: string) {
        console.log(`Received ${signal}. Shutting down Temporal client...`);
        await this.temporalClient.connection.close();
        console.log('Temporal client connection closed.');
    }
}