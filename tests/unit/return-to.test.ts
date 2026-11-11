import { describe, expect, it } from "vitest";
import { returnTo } from "@/lib/return-to";

describe("where sign-in sends a person afterwards", () => {
  it("keeps a page inside the app", () => {
    expect(returnTo("/constituent-center/mail/0b7c1f0e-3a55-4d0e-9a63-0d4f6f1f2a10")).toBe("/constituent-center/mail/0b7c1f0e-3a55-4d0e-9a63-0d4f6f1f2a10");
    expect(returnTo("/bills")).toBe("/bills");
    expect(returnTo("/constituent-center/topics/HB%20142")).toBe("/constituent-center/topics/HB%20142");
  });

  it("drops another site, however it is dressed up", () => {
    for (const bad of ["https://evil.example/", "//evil.example/path", "/\\evil.example", "/%5Cevil.example\\x", "javascript:alert(1)", "evil.example",
      "/ok?next=https://evil.example", "/ok#frag", "/a b", ""]) {
      expect(returnTo(bad), bad).toBeNull();
    }
    expect(returnTo(undefined)).toBeNull();
    expect(returnTo(null)).toBeNull();
    expect(returnTo(42)).toBeNull();
  });

  it("does not send a person back to sign-in, an API address or a search", () => {
    for (const bad of ["/login", "/login/mfa", "/api/export/tracked", "/_next/static/x.js", "/account/mfa", "/no-office",
      "/constituent-center/people?q=Ann+Lee"]) expect(returnTo(bad), bad).toBeNull();
    expect(returnTo(`/${"a".repeat(220)}`)).toBeNull();
  });
});
