import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { FleetService } from './fleet.service.js';

/**
 * UI-PUBLIC-2: public, unauthenticated read of the active passenger-capable fleet for the
 * website ("Nos bus"). Public fields only: no VIN, registration, status
 * history or seat map identifiers.
 */
@ApiTags('booking')
@Controller({ path: 'booking/fleet', version: '1' })
export class PublicFleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOkResponse({
    description:
      'Active passenger-capable vehicles: code, name, make, model year, seats of the configured seat map, on-board equipment.',
  })
  list() {
    return this.fleet.publicFleet();
  }
}
