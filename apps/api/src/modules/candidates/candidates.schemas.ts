// modules/candidates/candidates.schemas.ts
// Request schemas live in @exam/shared so the admin forms validate identically.
import { z } from 'zod';
export {
  CandidateCreateSchema,
  CandidateUpdateSchema,
  CandidateEligibilitySchema,
  CandidateBulkJobRoleSchema,
  CandidateLocationExemptSchema,
  CandidateResetSchema,
  CandidateListQuerySchema,
  CandidateDetailQuerySchema,
  CandidateImportPreviewBodySchema,
  ImportConfirmSchema,
} from '@exam/shared';

export const IdParamsSchema = z.object({ id: z.string().uuid() });
