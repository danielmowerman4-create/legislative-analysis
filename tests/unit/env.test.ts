import { afterEach, describe, expect, it } from "vitest";
import { getEnv, resetEnvForTests } from "@/server/env";
import { demoPassword } from "@/server/demo/center-seed";

const KEYS = ["APP_ENV", "DATABASE_URL", "SESSION_SECRET", "TOKEN_ENCRYPTION_KEY", "NEXT_PHASE"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
  resetEnvForTests();
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvForTests();
});

// The values in the Dockerfile and .github/workflows/ci.yml.
const DOCKER = { SESSION_SECRET: "build-placeholder-0000000000000000000000", TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
const CI = { SESSION_SECRET: "ci-session-secret-0123456789abcdef0123456789", TOKEN_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=" };

describe("public placeholder secrets", () => {
  it("are refused by a running server outside tests", () => {
    for (const APP_ENV of ["development", "demo"]) {
      for (const values of [DOCKER, CI]) {
        setEnv({ APP_ENV, ...values });
        expect(() => getEnv()).toThrow(/SESSION_SECRET is a public placeholder[\s\S]*TOKEN_ENCRYPTION_KEY is a public placeholder/);
      }
    }
  });

  it("are accepted while `next build` runs, as in the Dockerfile", () => {
    setEnv({ APP_ENV: "development", NEXT_PHASE: "phase-production-build", ...DOCKER });
    expect(getEnv().SESSION_SECRET).toBe(DOCKER.SESSION_SECRET);
  });

  it("are accepted under APP_ENV=test, as in CI", () => {
    setEnv({ APP_ENV: "test", ...CI });
    expect(getEnv().TOKEN_ENCRYPTION_KEY).toBe(CI.TOKEN_ENCRYPTION_KEY);
  });
});

describe("demo sign-in password", () => {
  it("is the well-known one only on the local embedded database", () => {
    setEnv({ DATABASE_URL: "pglite://.data/demo" });
    expect(demoPassword()).toBe("password");
    setEnv({ DATABASE_URL: "postgres://u:p@db.example:5432/li" });
    const a = demoPassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(demoPassword()).not.toBe(a);
  });
});
