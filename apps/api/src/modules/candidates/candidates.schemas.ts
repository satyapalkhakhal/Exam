// modules/candidates/candidates.schemas.ts
// Request schemas live in @exam/shared so the admin forms validate identically.
import { z } from 'zod';
export {
  CandidateCreateSchema,
  CandidateUpdateSchema,
  CandidateEligibilitySchema,
  CandidateLocationExemptSchema,
  CandidateResetSchema,
  CandidateListQuerySchema,
  CandidateDetailQuerySchema,
  CandidateImportPreviewBodySchema,
  RegistrationCreateSchema,
  ImportConfirmSchema,
} from '@exam/shared';

export const IdParamsSchema = z.object({ id: z.string().uuid() });
export const RegistrationParamsSchema = z.object({ id: z.string().uuid(), registrationId: z.string().uuid() });
export const EntryParamsSchema = z.object({ id: z.string().uuid(), entryId: z.string().uuid() });
