// tests/setup.ts
// Preloaded before every test file so importing modules that read `env` at load
// time never needs a real .env file or a live database.

const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/exam_test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ADMIN_SECRET: 'test-admin-secret-0123456789-abcdefghij',
  JWT_CANDIDATE_SECRET: 'test-candidate-secret-0123456789-abcdefg',
  CONFIG_ENCRYPTION_KEY: 'a'.repeat(64),
  PUBLIC_WEB_URL: 'http://localhost:5174',
  CORS_ORIGIN: 'http://localhost:5174',
};
for (const [k, v] of Object.entries(defaults)) process.env[k] ??= v;
