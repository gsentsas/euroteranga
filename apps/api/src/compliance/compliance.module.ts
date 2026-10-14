import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminComplianceRulesController } from './admin-compliance-rules.controller.js';
import { AdminComplianceController } from './admin-compliance.controller.js';
import { ComplianceEvaluationService } from './compliance-evaluation.service.js';
import { ComplianceRulesService } from './compliance-rules.service.js';
import { CustomerComplianceController } from './customer-compliance.controller.js';

/**
 * PR-12 regulatory compliance: versioned verified rules, deterministic
 * evaluation of booking passengers and append-only human review. Permits,
 * trip readiness, check-in and manifests belong to later domains.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [
    CustomerComplianceController,
    AdminComplianceRulesController,
    AdminComplianceController,
  ],
  providers: [ComplianceRulesService, ComplianceEvaluationService],
})
export class ComplianceModule {}
