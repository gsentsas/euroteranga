import { z } from 'zod';

const permitType = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z][A-Z0-9_.-]{1,63}$/u));

const scopeType = z.enum(['OPERATOR', 'COUNTRY', 'VEHICLE', 'ROUTE_VERSION', 'TRIP']);

const requirement = z
  .object({
    permitType,
    scopeType,
    countryIso2: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scopeType === 'COUNTRY' && !value.countryIso2) {
      context.addIssue({
        code: 'custom',
        path: ['countryIso2'],
        message: 'countryIso2 is required for COUNTRY scope',
      });
    }
    if (value.scopeType !== 'COUNTRY' && value.countryIso2) {
      context.addIssue({
        code: 'custom',
        path: ['countryIso2'],
        message: 'countryIso2 is only allowed for COUNTRY scope',
      });
    }
  });

/** A successful publication is immutable; corrections create a new version. */
export const departurePermitPolicySchema = z
  .object({ requirements: z.array(requirement).max(64) })
  .strict();

/** Mutations whose authority comes exclusively from the authenticated STAFF session. */
export const departureActionSchema = z.object({}).strict();
