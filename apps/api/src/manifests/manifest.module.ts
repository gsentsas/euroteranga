import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ManifestController } from './manifest.controller.js';
import { ManifestService } from './manifest.service.js';

/** PR-15 immutable passenger snapshots; no readiness or travel authorization. */
@Module({
  imports: [DatabaseModule],
  controllers: [ManifestController],
  providers: [ManifestService],
})
export class ManifestModule {}
