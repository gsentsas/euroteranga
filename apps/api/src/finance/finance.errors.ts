import { PublicApiError } from '../auth/http/public-api-error.js';

export const FinanceErrors = {
  tripNotFound: () => new PublicApiError(404, 'FINANCE_TRIP_NOT_FOUND', 'Voyage introuvable.'),
  revenueNotFound: () =>
    new PublicApiError(404, 'FINANCE_REVENUE_NOT_FOUND', 'Recette introuvable.'),
  expenseNotFound: () =>
    new PublicApiError(404, 'FINANCE_EXPENSE_NOT_FOUND', 'Dépense introuvable.'),
  paymentNotFound: () =>
    new PublicApiError(404, 'FINANCE_PAYMENT_NOT_FOUND', 'Paiement introuvable.'),
  invalidAmount: () =>
    new PublicApiError(422, 'FINANCE_AMOUNT_INVALID', 'Le montant financier est invalide.'),
  invalidBaggage: () =>
    new PublicApiError(
      422,
      'FINANCE_BAGGAGE_INVALID',
      'Le bagage doit appartenir au même voyage que la recette.',
    ),
  alreadyVoided: () =>
    new PublicApiError(409, 'FINANCE_ENTRY_VOIDED', 'Cette écriture est déjà annulée.'),
  paidExpenseCannotVoid: () =>
    new PublicApiError(
      409,
      'FINANCE_EXPENSE_ALREADY_PAID',
      'Une dépense avec un règlement enregistré ne peut plus être annulée.',
    ),
  refundPaymentInvalid: () =>
    new PublicApiError(
      409,
      'FINANCE_REFUND_PAYMENT_INVALID',
      'Un remboursement exige un paiement réussi.',
    ),
  refundExceedsPayment: () =>
    new PublicApiError(
      409,
      'FINANCE_REFUND_EXCEEDS_PAYMENT',
      'Le total des remboursements dépasse le paiement.',
    ),
  refundIdConflict: () =>
    new PublicApiError(
      409,
      'FINANCE_REFUND_ID_REUSED',
      'Cet identifiant de remboursement a déjà été utilisé avec un autre contenu.',
    ),
  payoutExceedsExpense: () =>
    new PublicApiError(
      409,
      'FINANCE_PAYOUT_EXCEEDS_EXPENSE',
      'Le total des règlements dépasse la dépense.',
    ),
  payoutIdConflict: () =>
    new PublicApiError(
      409,
      'FINANCE_PAYOUT_ID_REUSED',
      'Cet identifiant de règlement a déjà été utilisé avec un autre contenu.',
    ),
  timestampInvalid: () =>
    new PublicApiError(
      422,
      'FINANCE_TIMESTAMP_INVALID',
      'La date est trop éloignée dans le futur.',
    ),
  receiptNotFound: () =>
    new PublicApiError(404, 'FINANCE_RECEIPT_NOT_FOUND', 'Justificatif introuvable.'),
  receiptTooLarge: (maxBytes: number) =>
    new PublicApiError(
      413,
      'FINANCE_RECEIPT_TOO_LARGE',
      'Le justificatif dépasse la limite de ' + String(maxBytes) + ' octets.',
    ),
  receiptUnsupported: () =>
    new PublicApiError(
      415,
      'FINANCE_RECEIPT_UNSUPPORTED',
      'Seuls les fichiers PDF, JPEG et PNG sont acceptés.',
    ),
  receiptMalformed: () =>
    new PublicApiError(400, 'FINANCE_RECEIPT_MALFORMED', 'Le justificatif est mal formé.'),
  receiptMalware: () =>
    new PublicApiError(422, 'FINANCE_RECEIPT_MALWARE', 'Le justificatif a été rejeté.'),
  receiptUnavailable: () =>
    new PublicApiError(
      503,
      'FINANCE_RECEIPT_UNAVAILABLE',
      'Le stockage ou le contrôle du justificatif est indisponible.',
    ),
};
