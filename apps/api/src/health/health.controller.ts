import { Controller, Get, Header, Res, VERSION_NEUTRAL } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service.js';

export class HealthStatus {
  @ApiProperty({ enum: ['ok', 'error'] })
  status!: 'ok' | 'error';
}

/**
 * Public probes. Responses are deliberately minimal: no versions, hostnames,
 * paths or dependency details are exposed.
 *
 * - /health       basic availability, kept for simple monitors
 * - /health/live  the process is alive and serving HTTP (no dependency check)
 * - /health/ready the dependencies needed to serve traffic answer (database)
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: HealthStatus })
  check(): HealthStatus {
    return { status: 'ok' };
  }

  @Get('live')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: HealthStatus })
  live(): HealthStatus {
    return { status: 'ok' };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: HealthStatus })
  @ApiServiceUnavailableResponse({ type: HealthStatus })
  async ready(@Res({ passthrough: true }) response: Response): Promise<HealthStatus> {
    const ready = await this.health.isReady();
    if (!ready) response.status(503);
    return { status: ready ? 'ok' : 'error' };
  }
}
