// Test-only secrets, never used outside tests.
process.env.APP_ENV = "test";
process.env.APP_URL = "http://localhost:3000";
process.env.DATABASE_URL = "pglite://memory";
process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.WORKER_MODE = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.REDIS_URL;
