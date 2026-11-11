import { z } from "zod";

const optional = z.string().trim().optional().transform((v) => (v ? v : undefined));

const PUBLIC_PLACEHOLDERS = new Set([
  "build-placeholder-0000000000000000000000", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "ci-session-secret-0123456789abcdef0123456789",
  "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
]);

const schema = z.object({
  APP_ENV: z.enum(["development", "test", "demo", "production"]).default("development"), APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("pglite://.data/pglite"), SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  TOKEN_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  TOKEN_ENCRYPTION_KEY_ID: z.string().default("k1"), TOKEN_ENCRYPTION_OLD_KEYS: optional, REDIS_URL: optional,
  WORKER_MODE: z.enum(["inline", "external", "off"]).default("inline"), CT_SOURCE: z.enum(["live", "snapshot"]).default("live"),
  CONTACT_EMAIL: optional, GOOGLE_CLIENT_ID: optional, GOOGLE_CLIENT_SECRET: optional, GOOGLE_PUBSUB_TOPIC: optional,
  GOOGLE_PUBSUB_AUDIENCE: optional, GOOGLE_PUBSUB_SERVICE_ACCOUNT: optional, MICROSOFT_CLIENT_ID: optional, MICROSOFT_CLIENT_SECRET: optional,
  MICROSOFT_TENANT: z.string().default("organizations"), LEGISCAN_API_KEY: optional, OPENSTATES_API_KEY: optional, GEOCODIO_API_KEY: optional,
  ANTHROPIC_API_KEY: optional, ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_CLASSIFY_EFFORT: z.enum(["low", "medium", "high"]).default("low"), ANTHROPIC_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
})
  .superRefine((env, ctx) => {
    // `next build` runs with these; a running server must not, as they are public.
    if (env.APP_ENV !== "test" && process.env.NEXT_PHASE !== "phase-production-build") {
      if (PUBLIC_PLACEHOLDERS.has(env.SESSION_SECRET)) {
        ctx.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "SESSION_SECRET is a public placeholder" });
      }
      if (PUBLIC_PLACEHOLDERS.has(env.TOKEN_ENCRYPTION_KEY)) {
        ctx.addIssue({ code: "custom", path: ["TOKEN_ENCRYPTION_KEY"], message: "TOKEN_ENCRYPTION_KEY is a public placeholder" });
      }
    }
    if (env.APP_ENV === "production") {
      if (env.DATABASE_URL.startsWith("pglite://")) {
        ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "Production requires a PostgreSQL DATABASE_URL" });
      }
      if (!env.APP_URL.startsWith("https://")) {
        ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "Production APP_URL must be https" });
      }
    }
  });

type Env = z.infer<typeof schema>;

let cached: Env | undefined;

// Parsed lazily so `next build` can run without runtime secrets.
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvForTests() {
  cached = undefined;
}

export const integrationsConfigured = () => {
  const env = getEnv();
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), googlePush: Boolean(env.GOOGLE_PUBSUB_TOPIC && env.GOOGLE_PUBSUB_AUDIENCE),
    microsoft: Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET), anthropic: Boolean(env.ANTHROPIC_API_KEY),
    geocodio: Boolean(env.GEOCODIO_API_KEY), legiscan: Boolean(env.LEGISCAN_API_KEY), openstates: Boolean(env.OPENSTATES_API_KEY),
    redis: Boolean(env.REDIS_URL),
  };
};
