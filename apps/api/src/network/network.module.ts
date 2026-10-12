import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminNetworkController } from './admin-network.controller.js';
import { NetworkService } from './network.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AdminNetworkController],
  providers: [NetworkService],
  exports: [NetworkService],
})
export class NetworkModule {}
