// modules/questions/questions.schemas.ts
// Request schemas live in @exam/shared so the admin forms validate identically.
import { z } from 'zod';
export {
  QuestionCreateSchema,
  QuestionUpdateSchema,
  QuestionActiveSchema,
  QuestionOrderSchema,
  QuestionUnlockSchema,
  QuestionListQuerySchema,
  ImportPreviewBodySchema,
  ImportConfirmSchema,
} from '@exam/shared';

export const IdParamsSchema = z.object({ id: z.string().uuid() });
