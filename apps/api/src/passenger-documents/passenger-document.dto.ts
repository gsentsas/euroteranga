import { z } from 'zod';

export const DOCUMENT_TYPES = [
  'PASSPORT',
  'NATIONAL_ID',
  'RESIDENCE_PERMIT',
  'VISA',
  'PARENTAL_AUTHORIZATION',
  'OTHER',
] as const;

export const DOCUMENT_STATUSES = ['QUARANTINED', 'ACCEPTED', 'REJECTED'] as const;

const uuid = z.uuid();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((value, context) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      context.addIssue({ code: 'custom', message: 'invalid calendar date' });
      return z.NEVER;
    }
    return date;
  });

const name = z
  .string()
  .transform((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' '))
  .pipe(
    z
      .string()
      .min(1)
      .max(100)
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  );

export const passengerCreateSchema = z
  .object({
    givenName: name,
    familyName: name,
    dateOfBirth: isoDate,
    nationalityCountryId: uuid,
  })
  .strict()
  .refine((value) => value.dateOfBirth.getTime() <= Date.now(), {
    path: ['dateOfBirth'],
    message: 'date of birth cannot be in the future',
  });

export type PassengerCreate = z.infer<typeof passengerCreateSchema>;

/** Multipart text fields; the file itself is validated by the streaming parser. */
export const documentUploadFieldsSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES),
    expiresAt: isoDate.optional(),
  })
  .strict();

export type DocumentUploadFields = z.infer<typeof documentUploadFieldsSchema>;

export const adminDocumentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: uuid.optional(),
    type: z.enum(DOCUMENT_TYPES).optional(),
    status: z.enum(DOCUMENT_STATUSES).optional(),
    createdFrom: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    createdTo: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    bookingReference: z.string().trim().toUpperCase().max(16).optional(),
    passengerReference: z.string().trim().toUpperCase().max(16).optional(),
  })
  .strict()
  .refine(
    (value) => !value.createdFrom || !value.createdTo || value.createdFrom < value.createdTo,
    {
      path: ['createdTo'],
      message: 'createdTo must follow createdFrom',
    },
  );

export type AdminDocumentListQuery = z.infer<typeof adminDocumentListQuerySchema>;
