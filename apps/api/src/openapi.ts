import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * Builds the OpenAPI document from controller metadata. The interactive UI is
 * only mounted when OPENAPI_ENABLED=true; production exposure is undecided.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('EURO TERANGA API')
    .setDescription('Core API — Foundation. No business endpoints are available yet.')
    .setVersion('0.0.0')
    .build();
  return SwaggerModule.createDocument(app, config);
}
