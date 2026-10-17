import { z } from 'zod';

export const reportingTripStatusSchema = z.enum([
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);

const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const reportingQuerySchema = z
  .object({
    from: instant,
    to: instant,
    routeId: z.uuid().optional(),
    tripId: z.uuid().optional(),
    vehicleId: z.uuid().optional(),
    status: reportingTripStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.to <= value.from) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'must be after from' });
      return;
    }
    if (value.to.getTime() - value.from.getTime() > 366 * 24 * 60 * 60 * 1000) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'range exceeds 366 days' });
    }
  });
