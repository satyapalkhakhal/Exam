// schemas/auth.ts
// Zod contracts for candidate sign-in and location capture, shared by the API
// (validation) and the web forms. The identifier is an email or a 10-digit
// mobile; coordinates are range-checked and required together with GRANTED.

import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);
const mobile = z.string().trim().regex(/^\d{10}$/, 'Enter a 10-digit mobile number');

export const CandidateIdentifierSchema = z.union([email, mobile], {
  errorMap: () => ({ message: 'Enter your registered email or 10-digit mobile number' }),
});

export const CandidateRequestOtpSchema = z.object({ identifier: CandidateIdentifierSchema });
export type CandidateRequestOtpInput = z.infer<typeof CandidateRequestOtpSchema>;

export const CandidateVerifyOtpSchema = z.object({
  identifier: CandidateIdentifierSchema,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type CandidateVerifyOtpInput = z.infer<typeof CandidateVerifyOtpSchema>;

export const LocationStageSchema = z.enum(['LOGIN', 'EXAM_START']);
export const LocationPermissionSchema = z.enum(['GRANTED', 'DENIED', 'UNAVAILABLE', 'TIMEOUT', 'UNSUPPORTED']);

export const LocationPayloadSchema = z
  .object({
    stage: LocationStageSchema,
    permission: LocationPermissionSchema,
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    accuracyM: z.number().min(0).max(1_000_000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.permission !== 'GRANTED') return;
    if (v.latitude === undefined) ctx.addIssue({ code: 'custom', path: ['latitude'], message: 'latitude is required when permission is GRANTED' });
    if (v.longitude === undefined) ctx.addIssue({ code: 'custom', path: ['longitude'], message: 'longitude is required when permission is GRANTED' });
  });
export type LocationPayloadInput = z.infer<typeof LocationPayloadSchema>;

export interface CandidateSelf {
  id: string;
  candidateCode: string;
  fullName: string;
  email: string;
  jobRole: { id: string; name: string };
  status: string;
  locationCaptured: boolean;
  locationExempt: boolean;
}
