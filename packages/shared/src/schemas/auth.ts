// schemas/auth.ts
// Zod contracts for candidate sign-in and location capture, shared by the API
// (validation) and the web forms. The identifier is an email or a 10-digit
// mobile; coordinates are range-checked and required together with GRANTED.

import { z } from 'zod';
import { normalizeMobile } from './candidates.js';

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

// First-time mobile registration: email + roll number identify the imported
// candidate, the SMS code proves the mobile. Mobile is normalised the same way
// as the import (+91 / 0 prefixes and separators stripped, must start 6-9).
const linkMobile = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const m = normalizeMobile(v);
    if (m === null) {
      ctx.addIssue({ code: 'custom', message: 'Enter a 10-digit Indian mobile number' });
      return z.NEVER;
    }
    return m;
  });

export const CandidateMobileLinkRequestSchema = z.object({
  email,
  rollNumber: z.string().trim().min(1, 'Enter your roll number').max(200),
  mobile: linkMobile,
});
export type CandidateMobileLinkRequestInput = z.infer<typeof CandidateMobileLinkRequestSchema>;

export const CandidateMobileLinkVerifySchema = CandidateMobileLinkRequestSchema.extend({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type CandidateMobileLinkVerifyInput = z.infer<typeof CandidateMobileLinkVerifySchema>;

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

/**
 * The signed-in person (a candidate account), not one application: per-role
 * data (code, role, status, exemption) lives in CandidateExamDto.
 */
export interface CandidateSelf {
  /** candidate_accounts.id */
  id: string;
  /** From the most recently created eligible application. */
  fullName: string;
  email: string;
  /** A GRANTED LOGIN location exists for this login session. */
  locationCaptured: boolean;
  /** True when every eligible application is location-exempt (the location step can be skipped). */
  locationExempt: boolean;
  /** Number of eligible applications. */
  examCount: number;
}
