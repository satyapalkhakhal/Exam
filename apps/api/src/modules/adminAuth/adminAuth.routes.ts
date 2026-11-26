// modules/adminAuth/adminAuth.routes.ts
// /api/admin/auth. Login is rate limited per IP + email and OTP verification
// per IP; refresh and logout
// work from the refresh cookie alone, so an expired access token can still
// sign out. Forgot/reset password are public and rate limited per IP.

import { Router } from 'express';
import { authenticateAdmin } from '../../shared/middleware/authenticateAdmin.js';
import {
  adminForgotPasswordLimiter,
  adminLoginLimiter,
  adminOtpVerifyLimiter,
  adminResetPasswordLimiter,
} from '../../shared/middleware/rateLimit.js';
import { validate } from '../../shared/middleware/validate.js';
import { createAdminAuthController } from './adminAuth.controller.js';
import { AdminForgotPasswordSchema, AdminLoginSchema, AdminResetPasswordSchema, AdminVerifyOtpSchema } from './adminAuth.schemas.js';
import type { AdminAuthService } from './adminAuth.service.js';

export function createAdminAuthRouter(service: AdminAuthService): Router {
  const c = createAdminAuthController(service);
  const r = Router();
  r.post('/login', adminLoginLimiter, validate({ body: AdminLoginSchema }), c.login);
  r.post('/verify-otp', adminOtpVerifyLimiter, validate({ body: AdminVerifyOtpSchema }), c.verifyOtp);
  r.post('/forgot-password', adminForgotPasswordLimiter, validate({ body: AdminForgotPasswordSchema }), c.forgotPassword);
  r.post('/reset-password', adminResetPasswordLimiter, validate({ body: AdminResetPasswordSchema }), c.resetPassword);
  r.post('/refresh', c.refresh);
  r.post('/logout', c.logout);
  r.post('/logout-all', authenticateAdmin, c.logoutAll);
  r.get('/me', authenticateAdmin, c.me);
  return r;
}
