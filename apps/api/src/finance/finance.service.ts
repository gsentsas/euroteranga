import { Prisma } from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  MalwareScannerError,
  MALWARE_SCANNER,
  type MalwareScanner,
} from '../passenger-documents/malware/malware-scanner.js';
import {
  PASSENGER_DOCUMENT_CONFIG,
  type PassengerDocumentConfig,
} from '../passenger-documents/passenger-document.config.js';
import { UploadValidationError } from '../passenger-documents/passenger-document-upload.js';
import {
  ObjectStorageError,
  OBJECT_STORAGE_PROVIDER,
  type ObjectStorageProvider,
  type StoredObject,
} from '../passenger-documents/storage/object-storage.provider.js';
import type {
  expenseCreateSchema,
  financeVoidSchema,
  payoutCreateSchema,
  refundCreateSchema,
  revenueCreateSchema,
} from './finance.dto.js';
import { FinanceErrors } from './finance.errors.js';
import { parseFinanceReceiptUpload } from './finance-receipt-upload.js';
import {
  exactMinorAmount,
  financeReceiptObjectKey,
  generateFinanceReference,
} from './finance-rules.js';
import { buildFinanceCurrencySummary } from './finance-summary.js';

type RevenueInput = z.infer<typeof revenueCreateSchema>;
type ExpenseInput = z.infer<typeof expenseCreateSchema>;
type VoidInput = z.infer<typeof financeVoidSchema>;
type RefundInput = z.infer<typeof refundCreateSchema>;
type PayoutInput = z.infer<typeof payoutCreateSchema>;

const revenueSelect = {
  id: true,
  reference: true,
  type: true,
  status: true,
  amountMinor: true,
  currencyCode: true,
  currencyMinorUnit: true,
  description: true,
  occurredAt: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
  baggage: { select: { reference: true } },
} satisfies Prisma.TripRevenueSelect;

const expenseSelect = {
  id: true,
  reference: true,
  type: true,
  status: true,
  amountMinor: true,
  currencyCode: true,
  currencyMinorUnit: true,
  description: true,
  vendorLabel: true,
  occurredAt: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
  payouts: {
    orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      reference: true,
      amountMinor: true,
      currencyCode: true,
      currencyMinorUnit: true,
      note: true,
      paidAt: true,
      recordedAt: true,
    },
  },
  receipts: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      reference: true,
      sha256: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
    },
  },
} satisfies Prisma.TripExpenseSelect;

function revenueView(row: Prisma.TripRevenueGetPayload<{ select: typeof revenueSelect }>) {
  return { ...row, amountMinor: row.amountMinor.toString() };
}

function expenseView(row: Prisma.TripExpenseGetPayload<{ select: typeof expenseSelect }>) {
  return {
    ...row,
    amountMinor: row.amountMinor.toString(),
    payouts: row.payouts.map((payout) => ({
      ...payout,
      amountMinor: payout.amountMinor.toString(),
    })),
  };
}

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function mapDatabaseViolation(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  const message = String(error instanceof Error ? error.message : error);
  if (message.includes('baggage revenue must use')) throw FinanceErrors.invalidBaggage();
  if (message.includes('voided revenue') || message.includes('voided expense')) {
    throw FinanceErrors.alreadyVoided();
  }
  if (message.includes('expense with payouts')) throw FinanceErrors.paidExpenseCannotVoid();
  if (message.includes('refund requires a SUCCEEDED payment'))
    throw FinanceErrors.refundPaymentInvalid();
  if (message.includes('refund total exceeds')) throw FinanceErrors.refundExceedsPayment();
  if (message.includes('payout total exceeds')) throw FinanceErrors.payoutExceedsExpense();
  if (message.includes('paid_at too far') || message.includes('occurred_at too far')) {
    throw FinanceErrors.timestampInvalid();
  }
  throw error;
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(PASSENGER_DOCUMENT_CONFIG) private readonly documentConfig: PassengerDocumentConfig,
    @Inject(OBJECT_STORAGE_PROVIDER) private readonly storage: ObjectStorageProvider,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  private async trip(rawReference: string) {
    const trip = await this.database.client.trip.findUnique({
      where: { reference: rawReference.trim().toUpperCase() },
      select: { id: true, reference: true, status: true },
    });
    if (!trip) throw FinanceErrors.tripNotFound();
    return trip;
  }

  async tripSummary(actor: AuthPrincipal, rawTripReference: string) {
    const trip = await this.trip(rawTripReference);
    const [payments, revenues, expenses] = await Promise.all([
      this.database.client.payment.findMany({
        where: { booking: { tripId: trip.id }, status: 'SUCCEEDED' },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          reference: true,
          amountMinor: true,
          currencyCode: true,
          currencyMinorUnit: true,
          booking: { select: { reference: true, cancelledAt: true } },
          refunds: {
            orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              reference: true,
              amountMinor: true,
              reason: true,
              recordedAt: true,
              creditNote: { select: { reference: true, issuedAt: true } },
            },
          },
        },
      }),
      this.database.client.tripRevenue.findMany({
        where: { tripId: trip.id },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: revenueSelect,
      }),
      this.database.client.tripExpense.findMany({
        where: { tripId: trip.id },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: expenseSelect,
      }),
    ]);

    const currencies = buildFinanceCurrencySummary({ payments, revenues, expenses });

    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'FINANCE_TRIP_ACCESSED',
          resourceType: 'trip',
          resourceId: trip.id,
          metadata: {
            tripReference: trip.reference,
            currencies: currencies.map((currency) => currency.currencyCode),
          },
        },
        tx,
      ),
    );

    return {
      trip,
      currencies,
      payments: payments.map((payment) => ({
        ...payment,
        amountMinor: payment.amountMinor.toString(),
        refunds: payment.refunds.map((refund) => ({
          ...refund,
          amountMinor: refund.amountMinor.toString(),
        })),
      })),
      revenues: revenues.map(revenueView),
      expenses: expenses.map(expenseView),
      fxConversionApplied: false,
    };
  }

  async createRevenue(actor: AuthPrincipal, rawTripReference: string, input: RevenueInput) {
    const trip = await this.trip(rawTripReference);
    const amountMinor = this.amount(input.amountMinor);
    let baggageId: string | undefined;
    if (input.baggageReference) {
      const baggage = await this.database.client.baggage.findUnique({
        where: { reference: input.baggageReference },
        select: { id: true },
      });
      if (!baggage) throw FinanceErrors.invalidBaggage();
      baggageId = baggage.id;
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.database.client.$transaction(async (tx) => {
          const row = await tx.tripRevenue.create({
            data: {
              reference: generateFinanceReference('revenue'),
              tripId: trip.id,
              ...(baggageId ? { baggageId } : {}),
              type: input.type,
              amountMinor,
              currencyCode: input.currencyCode,
              currencyMinorUnit: input.currencyMinorUnit,
              description: input.description,
              occurredAt: input.occurredAt,
              createdByIdentityId: actor.identityId,
            },
            select: revenueSelect,
          });
          await this.audit.record(
            {
              actor,
              action: 'FINANCE_REVENUE_RECORDED',
              resourceType: 'trip_revenue',
              resourceId: row.id,
              after: {
                reference: row.reference,
                tripReference: trip.reference,
                type: row.type,
                amountMinor: row.amountMinor.toString(),
                currencyCode: row.currencyCode,
              },
            },
            tx,
          );
          return revenueView(row);
        });
      } catch (error) {
        if (uniqueViolation(error) && attempt < 3) continue;
        mapDatabaseViolation(error);
      }
    }
    throw FinanceErrors.invalidAmount();
  }

  async createExpense(actor: AuthPrincipal, rawTripReference: string, input: ExpenseInput) {
    const trip = await this.trip(rawTripReference);
    const amountMinor = this.amount(input.amountMinor);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.database.client.$transaction(async (tx) => {
          const row = await tx.tripExpense.create({
            data: {
              reference: generateFinanceReference('expense'),
              tripId: trip.id,
              type: input.type,
              amountMinor,
              currencyCode: input.currencyCode,
              currencyMinorUnit: input.currencyMinorUnit,
              description: input.description,
              ...(input.vendorLabel ? { vendorLabel: input.vendorLabel } : {}),
              occurredAt: input.occurredAt,
              createdByIdentityId: actor.identityId,
            },
            select: expenseSelect,
          });
          await this.audit.record(
            {
              actor,
              action: 'FINANCE_EXPENSE_RECORDED',
              resourceType: 'trip_expense',
              resourceId: row.id,
              after: {
                reference: row.reference,
                tripReference: trip.reference,
                type: row.type,
                amountMinor: row.amountMinor.toString(),
                currencyCode: row.currencyCode,
              },
            },
            tx,
          );
          return expenseView(row);
        });
      } catch (error) {
        if (uniqueViolation(error) && attempt < 3) continue;
        mapDatabaseViolation(error);
      }
    }
    throw FinanceErrors.invalidAmount();
  }

  async voidRevenue(actor: AuthPrincipal, reference: string, input: VoidInput) {
    try {
      return await this.database.client.$transaction(async (tx) => {
        const current = await tx.tripRevenue.findUnique({
          where: { reference },
          select: { id: true, status: true },
        });
        if (!current) throw FinanceErrors.revenueNotFound();
        if (current.status === 'VOIDED') throw FinanceErrors.alreadyVoided();
        const row = await tx.tripRevenue.update({
          where: { id: current.id },
          data: {
            status: 'VOIDED',
            voidedByIdentityId: actor.identityId,
            voidReason: input.reason,
          },
          select: revenueSelect,
        });
        await this.audit.record(
          {
            actor,
            action: 'FINANCE_REVENUE_VOIDED',
            resourceType: 'trip_revenue',
            resourceId: row.id,
            before: { status: 'ACTIVE' },
            after: { status: row.status, reference: row.reference, reason: input.reason },
          },
          tx,
        );
        return revenueView(row);
      });
    } catch (error) {
      mapDatabaseViolation(error);
    }
  }

  async voidExpense(actor: AuthPrincipal, reference: string, input: VoidInput) {
    try {
      return await this.database.client.$transaction(async (tx) => {
        const current = await tx.tripExpense.findUnique({
          where: { reference },
          select: { id: true, status: true },
        });
        if (!current) throw FinanceErrors.expenseNotFound();
        if (current.status === 'VOIDED') throw FinanceErrors.alreadyVoided();
        const row = await tx.tripExpense.update({
          where: { id: current.id },
          data: {
            status: 'VOIDED',
            voidedByIdentityId: actor.identityId,
            voidReason: input.reason,
          },
          select: expenseSelect,
        });
        await this.audit.record(
          {
            actor,
            action: 'FINANCE_EXPENSE_VOIDED',
            resourceType: 'trip_expense',
            resourceId: row.id,
            before: { status: 'ACTIVE' },
            after: { status: row.status, reference: row.reference, reason: input.reason },
          },
          tx,
        );
        return expenseView(row);
      });
    } catch (error) {
      mapDatabaseViolation(error);
    }
  }

  async refundPayment(actor: AuthPrincipal, paymentReference: string, input: RefundInput) {
    const payment = await this.database.client.payment.findUnique({
      where: { reference: paymentReference },
      select: {
        id: true,
        reference: true,
        status: true,
        amountMinor: true,
        currencyCode: true,
        currencyMinorUnit: true,
        booking: { select: { reference: true, trip: { select: { reference: true } } } },
      },
    });
    if (!payment) throw FinanceErrors.paymentNotFound();
    if (payment.status !== 'SUCCEEDED') throw FinanceErrors.refundPaymentInvalid();
    const amountMinor = this.amount(input.amountMinor);
    const replay = await this.database.client.refund.findUnique({
      where: {
        paymentId_clientRefundId: {
          paymentId: payment.id,
          clientRefundId: input.clientRefundId,
        },
      },
      select: {
        id: true,
        reference: true,
        amountMinor: true,
        reason: true,
        creditNote: { select: { reference: true } },
      },
    });
    if (replay) {
      if (replay.amountMinor !== amountMinor || replay.reason !== input.reason) {
        throw FinanceErrors.refundIdConflict();
      }
      return { created: false, refund: { ...replay, amountMinor: replay.amountMinor.toString() } };
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.database.client.$transaction(async (tx) => {
          const refund = await tx.refund.create({
            data: {
              reference: generateFinanceReference('refund'),
              paymentId: payment.id,
              clientRefundId: input.clientRefundId,
              amountMinor,
              currencyCode: payment.currencyCode,
              currencyMinorUnit: payment.currencyMinorUnit,
              reason: input.reason,
              recordedByIdentityId: actor.identityId,
            },
            select: { id: true, reference: true, amountMinor: true, reason: true },
          });
          const creditNote = await tx.creditNote.create({
            data: {
              reference: generateFinanceReference('creditNote'),
              refundId: refund.id,
              amountMinor,
              currencyCode: payment.currencyCode,
              currencyMinorUnit: payment.currencyMinorUnit,
              issuedByIdentityId: actor.identityId,
            },
            select: { reference: true, issuedAt: true },
          });
          await this.audit.record(
            {
              actor,
              action: 'PAYMENT_REFUNDED',
              resourceType: 'refund',
              resourceId: refund.id,
              after: {
                reference: refund.reference,
                paymentReference: payment.reference,
                bookingReference: payment.booking.reference,
                tripReference: payment.booking.trip.reference,
                amountMinor: refund.amountMinor.toString(),
                currencyCode: payment.currencyCode,
                creditNoteReference: creditNote.reference,
              },
              metadata: { reason: input.reason },
            },
            tx,
          );
          return {
            created: true,
            refund: {
              reference: refund.reference,
              amountMinor: refund.amountMinor.toString(),
              reason: refund.reason,
              creditNote,
            },
          };
        });
      } catch (error) {
        if (uniqueViolation(error)) {
          const replayAfterRace = await this.database.client.refund.findUnique({
            where: {
              paymentId_clientRefundId: {
                paymentId: payment.id,
                clientRefundId: input.clientRefundId,
              },
            },
            select: {
              id: true,
              reference: true,
              amountMinor: true,
              reason: true,
              creditNote: { select: { reference: true } },
            },
          });
          if (replayAfterRace) {
            if (
              replayAfterRace.amountMinor !== amountMinor ||
              replayAfterRace.reason !== input.reason
            ) {
              throw FinanceErrors.refundIdConflict();
            }
            return {
              created: false,
              refund: {
                ...replayAfterRace,
                amountMinor: replayAfterRace.amountMinor.toString(),
              },
            };
          }
          if (attempt < 3) continue;
        }
        mapDatabaseViolation(error);
      }
    }
    throw FinanceErrors.refundIdConflict();
  }

  async recordPayout(actor: AuthPrincipal, expenseReference: string, input: PayoutInput) {
    const expense = await this.database.client.tripExpense.findUnique({
      where: { reference: expenseReference },
      select: {
        id: true,
        reference: true,
        status: true,
        currencyCode: true,
        currencyMinorUnit: true,
      },
    });
    if (!expense) throw FinanceErrors.expenseNotFound();
    const amountMinor = this.amount(input.amountMinor);
    const replay = await this.database.client.payout.findUnique({
      where: {
        expenseId_clientPayoutId: {
          expenseId: expense.id,
          clientPayoutId: input.clientPayoutId,
        },
      },
      select: { reference: true, amountMinor: true, note: true, paidAt: true },
    });
    if (replay) {
      if (
        replay.amountMinor !== amountMinor ||
        (replay.note ?? undefined) !== input.note ||
        replay.paidAt.getTime() !== input.paidAt.getTime()
      ) {
        throw FinanceErrors.payoutIdConflict();
      }
      return { created: false, payout: { ...replay, amountMinor: replay.amountMinor.toString() } };
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.database.client.$transaction(async (tx) => {
          const payout = await tx.payout.create({
            data: {
              reference: generateFinanceReference('payout'),
              expenseId: expense.id,
              clientPayoutId: input.clientPayoutId,
              amountMinor,
              currencyCode: expense.currencyCode,
              currencyMinorUnit: expense.currencyMinorUnit,
              ...(input.note ? { note: input.note } : {}),
              recordedByIdentityId: actor.identityId,
              paidAt: input.paidAt,
            },
            select: {
              id: true,
              reference: true,
              amountMinor: true,
              currencyCode: true,
              currencyMinorUnit: true,
              note: true,
              paidAt: true,
              recordedAt: true,
            },
          });
          await this.audit.record(
            {
              actor,
              action: 'FINANCE_PAYOUT_RECORDED',
              resourceType: 'payout',
              resourceId: payout.id,
              after: {
                reference: payout.reference,
                expenseReference: expense.reference,
                amountMinor: payout.amountMinor.toString(),
                currencyCode: expense.currencyCode,
              },
            },
            tx,
          );
          return {
            created: true,
            payout: { ...payout, amountMinor: payout.amountMinor.toString() },
          };
        });
      } catch (error) {
        if (uniqueViolation(error) && attempt < 3) continue;
        mapDatabaseViolation(error);
      }
    }
    throw FinanceErrors.payoutIdConflict();
  }

  async uploadReceipt(actor: AuthPrincipal, expenseReference: string, request: Request) {
    const expense = await this.database.client.tripExpense.findUnique({
      where: { reference: expenseReference },
      select: { id: true, status: true },
    });
    if (!expense) throw FinanceErrors.expenseNotFound();
    if (expense.status !== 'ACTIVE') throw FinanceErrors.alreadyVoided();
    if (
      this.documentConfig.storage.provider === 'DISABLED' ||
      this.documentConfig.malware.scanner === 'DISABLED'
    ) {
      throw FinanceErrors.receiptUnavailable();
    }

    let upload;
    try {
      upload = await parseFinanceReceiptUpload(request, this.documentConfig.maxBytes);
    } catch (error) {
      if (error instanceof UploadValidationError) return this.receiptUploadError(error);
      throw error;
    }

    let objectKey: string | null = null;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = financeReceiptObjectKey();
        try {
          await this.storage.put({
            key: candidate,
            body: upload.body(),
            sizeBytes: upload.sizeBytes,
            mimeType: upload.mimeType,
          });
          objectKey = candidate;
          break;
        } catch (error) {
          if (error instanceof ObjectStorageError && error.code === 'CONFLICT') continue;
          throw FinanceErrors.receiptUnavailable();
        }
      }
      if (!objectKey) throw FinanceErrors.receiptUnavailable();
      const storedObjectKey = objectKey;
      const stored = await this.storage.get(storedObjectKey).catch(() => null);
      if (!stored || stored.sizeBytes !== upload.sizeBytes) {
        stored?.body.destroy();
        await this.deleteObject(storedObjectKey);
        throw FinanceErrors.receiptUnavailable();
      }
      try {
        const scan = await this.scanner.scan(stored.body);
        if (scan.status === 'MALWARE') {
          await this.deleteObject(storedObjectKey);
          throw FinanceErrors.receiptMalware();
        }
      } catch (error) {
        if (error instanceof PublicApiError) throw error;
        await this.deleteObject(storedObjectKey);
        if (error instanceof MalwareScannerError) throw FinanceErrors.receiptUnavailable();
        throw FinanceErrors.receiptUnavailable();
      }

      try {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            return await this.database.client.$transaction(async (tx) => {
              const receipt = await tx.financeReceipt.create({
                data: {
                  reference: generateFinanceReference('receipt'),
                  expenseId: expense.id,
                  objectKey: storedObjectKey,
                  sha256: upload.sha256,
                  mimeType: upload.mimeType,
                  sizeBytes: upload.sizeBytes,
                  uploadedByIdentityId: actor.identityId,
                },
                select: {
                  id: true,
                  reference: true,
                  sha256: true,
                  mimeType: true,
                  sizeBytes: true,
                  createdAt: true,
                },
              });
              await this.audit.record(
                {
                  actor,
                  action: 'FINANCE_RECEIPT_UPLOADED',
                  resourceType: 'finance_receipt',
                  resourceId: receipt.id,
                  after: {
                    reference: receipt.reference,
                    expenseReference,
                    mimeType: receipt.mimeType,
                    sizeBytes: receipt.sizeBytes,
                    sha256: receipt.sha256,
                  },
                },
                tx,
              );
              return receipt;
            });
          } catch (error) {
            if (uniqueViolation(error) && attempt < 3) continue;
            throw error;
          }
        }
        throw FinanceErrors.receiptUnavailable();
      } catch (error) {
        await this.deleteObject(storedObjectKey);
        mapDatabaseViolation(error);
      }
    } finally {
      await upload.cleanup();
    }
  }

  async downloadReceipt(
    actor: AuthPrincipal,
    expenseReference: string,
    receiptId: string,
  ): Promise<{
    receipt: { id: string; reference: string; mimeType: string; sizeBytes: number };
    stored: StoredObject;
  }> {
    const receipt = await this.database.client.financeReceipt.findFirst({
      where: { id: receiptId, expense: { reference: expenseReference } },
      select: {
        id: true,
        reference: true,
        objectKey: true,
        mimeType: true,
        sizeBytes: true,
        expenseId: true,
      },
    });
    if (!receipt) throw FinanceErrors.receiptNotFound();
    const stored = await this.storage.get(receipt.objectKey).catch(() => null);
    if (!stored || stored.sizeBytes !== receipt.sizeBytes) {
      stored?.body.destroy();
      throw FinanceErrors.receiptUnavailable();
    }
    try {
      await this.database.client.$transaction((tx) =>
        this.audit.record(
          {
            actor,
            action: 'FINANCE_RECEIPT_ACCESSED',
            resourceType: 'finance_receipt',
            resourceId: receipt.id,
            metadata: {
              expenseReference,
              receiptReference: receipt.reference,
              access: 'CONTENT',
            },
          },
          tx,
        ),
      );
    } catch (error) {
      stored.body.destroy();
      throw error;
    }
    return {
      receipt: {
        id: receipt.id,
        reference: receipt.reference,
        mimeType: receipt.mimeType,
        sizeBytes: receipt.sizeBytes,
      },
      stored,
    };
  }

  private amount(raw: string): bigint {
    try {
      return exactMinorAmount(raw);
    } catch {
      throw FinanceErrors.invalidAmount();
    }
  }

  private receiptUploadError(error: UploadValidationError): never {
    if (error.code === 'TOO_LARGE') {
      throw FinanceErrors.receiptTooLarge(this.documentConfig.maxBytes);
    }
    if (error.code === 'UNSUPPORTED_MEDIA' || error.code === 'UNSAFE_FILENAME') {
      throw FinanceErrors.receiptUnsupported();
    }
    throw FinanceErrors.receiptMalformed();
  }

  private async deleteObject(key: string): Promise<void> {
    await this.storage.delete(key).catch(() => undefined);
  }
}
