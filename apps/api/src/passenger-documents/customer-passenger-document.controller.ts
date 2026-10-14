import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import {
  AuthRequestGuard,
  CsrfGuard,
  MultipartRoute,
  SessionGuard,
} from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { passengerCreateSchema } from './passenger-document.dto.js';
import { downloadFilename } from './passenger-document-rules.js';
import { PassengerDocumentService } from './passenger-document.service.js';

@ApiTags('booking: passengers and documents')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Origin or CSRF token invalid' })
@Controller({ path: 'booking', version: '1' })
@AuthRealmRoute('customer')
@UseGuards(AuthRequestGuard, SessionGuard)
export class CustomerPassengerDocumentController {
  constructor(private readonly documents: PassengerDocumentService) {}

  @Get('passenger-countries')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Active nationality choices for passenger entry.' })
  countries() {
    return this.documents.passengerCountries();
  }

  @Post('bookings/:bookingReference/passengers')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Passenger created and attached to the confirmed booking.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  @ApiUnprocessableEntityResponse({ type: ErrorBody })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['givenName', 'familyName', 'dateOfBirth', 'nationalityCountryId'],
      properties: {
        givenName: { type: 'string', maxLength: 100 },
        familyName: { type: 'string', maxLength: 100 },
        dateOfBirth: { type: 'string', format: 'date' },
        nationalityCountryId: { type: 'string', format: 'uuid' },
      },
    },
  })
  createPassenger(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
    @Body(new ZodValidationPipe(passengerCreateSchema))
    body: z.infer<typeof passengerCreateSchema>,
  ) {
    return this.documents.createPassenger(principal, bookingReference, body);
  }

  @Get('bookings/:bookingReference/passengers')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Passengers attached to one booking owned by the caller.' })
  passengers(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
  ) {
    return this.documents.bookingPassengers(principal, bookingReference);
  }

  @Get('passengers/:passengerReference')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'One passenger owned by the caller.' })
  passenger(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('passengerReference') passengerReference: string,
  ) {
    return this.documents.customerPassenger(principal, passengerReference);
  }

  @Post('passengers/:passengerReference/documents')
  @MultipartRoute()
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({
    description: 'File accepted technically after private quarantine and scan.',
  })
  @ApiPayloadTooLargeResponse({ type: ErrorBody })
  @ApiUnprocessableEntityResponse({ type: ErrorBody })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['type', 'file'],
      properties: {
        type: {
          type: 'string',
          enum: [
            'PASSPORT',
            'NATIONAL_ID',
            'RESIDENCE_PERMIT',
            'VISA',
            'PARENTAL_AUTHORIZATION',
            'OTHER',
          ],
        },
        expiresAt: { type: 'string', format: 'date' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  upload(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('passengerReference') passengerReference: string,
    @Req() request: Request,
  ) {
    return this.documents.upload(principal, passengerReference, request);
  }

  @Get('passengers/:passengerReference/documents')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: 'Technical document metadata of one passenger owned by the caller.',
  })
  passengerDocuments(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('passengerReference') passengerReference: string,
  ) {
    return this.documents.customerDocuments(principal, passengerReference);
  }

  @Get('documents/:documentReference/download')
  @ApiOkResponse({ description: 'Authenticated private stream of an ACCEPTED file.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  async download(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('documentReference') documentReference: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { document, stored } = await this.documents.customerDownload(
      principal,
      documentReference,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', document.mimeType);
    response.setHeader('Content-Length', String(stored.sizeBytes));
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${downloadFilename(document.reference, document.mimeType)}"`,
    );
    return new StreamableFile(stored.body);
  }
}
