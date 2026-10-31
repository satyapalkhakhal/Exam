// api.ts
// The single response envelope and the closed set of error codes. Every later
// task that needs a new code adds it to ErrorCode here so web and api stay in step.

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'BAD_REQUEST'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'OTP_LOCKED'
  | 'OTP_COOLDOWN'
  | 'OTP_DELIVERY_UNCONFIGURED'
  | 'OTP_DELIVERY_FAILED'
  | 'ACCOUNT_LOCKED'
  | 'EXAM_NOT_OPEN'
  | 'EXAM_WINDOW_CLOSED'
  | 'LOCATION_REQUIRED'
  | 'ALREADY_ATTEMPTED'
  | 'ATTEMPT_LOCKED'
  | 'SESSION_SUPERSEDED'
  | 'QUESTIONS_LOCKED'
  | 'EVALUATION_LOCKED'
  | 'MARKS_OUT_OF_RANGE'
  | 'ROLE_CHANGE_FORBIDDEN'
  | 'EXAM_IN_PROGRESS'
  | 'BAD_GATEWAY';

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: { message: string; code: ErrorCode; details?: unknown };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
