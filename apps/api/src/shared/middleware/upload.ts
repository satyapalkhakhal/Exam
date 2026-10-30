// shared/middleware/upload.ts
// Generic spreadsheet upload (questions now, candidates next): multer in
// memory, 5 MB cap, extension AND MIME allow-list. The buffer never touches
// disk; readSheet parses it with row/column caps. Multer failures become the
// standard error envelope.

import path from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { AppError, badRequest } from '../errors.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ALLOWED: Record<string, readonly string[]> = {
  '.csv': ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  fileFilter(_req, file, cb) {
    const mimes = ALLOWED[path.extname(file.originalname).toLowerCase()];
    if (!mimes || !mimes.includes(file.mimetype.toLowerCase())) {
      cb(badRequest('Only .csv and .xlsx files are supported'));
      return;
    }
    cb(null, true);
  },
});

export function uploadSpreadsheet(field = 'file'): RequestHandler {
  const single = uploader.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    single(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'The file is larger than 5 MB'));
        return next(badRequest('Invalid upload'));
      }
      return next(err);
    });
  };
}
