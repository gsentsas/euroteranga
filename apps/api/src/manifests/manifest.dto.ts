import { z } from 'zod';

const tripReference = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().min(1).max(32));

export const manifestListQuerySchema = z
  .object({
    tripReference,
    limit: z.coerce.number().int().min(1).max(100).default(25),
    /** Version of the last item returned; the next page contains lower versions. */
    cursor: z.coerce.number().int().positive().optional(),
  })
  .strict();

/** Generation has no client-controlled content: all facts come from the DB. */
export const manifestGenerationSchema = z.object({}).strict();

export type ManifestListQuery = z.infer<typeof manifestListQuerySchema>;
