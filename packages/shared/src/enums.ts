// enums.ts
// String enums shared by the API (Prisma mirrors them) and the web app. Later
// tasks extend this file as their tables arrive.

export const AdminRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  EVALUATOR: 'EVALUATOR',
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

export const SubmitType = {
  MANUAL: 'MANUAL',
  AUTO: 'AUTO',
} as const;
export type SubmitType = (typeof SubmitType)[keyof typeof SubmitType];

export const EvaluationStatus = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
} as const;
export type EvaluationStatus = (typeof EvaluationStatus)[keyof typeof EvaluationStatus];
