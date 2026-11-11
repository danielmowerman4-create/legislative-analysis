import { describe, expect, it } from "vitest";
import { clientIp } from "@/server/auth/next";

describe("the address a request came from", () => {
  it("trusts the address Railway's edge sets over anything the client sent", () => {
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4, 198.51.100.7" }))).toBe("198.51.100.7");
  });

  it("otherwise takes the right-most forwarded address, never the client-written left one", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.9 , 198.51.100.8 " }))).toBe("198.51.100.8");
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.9" }))).toBe("198.51.100.9");
  });

  it("is unknown when neither header says", () => {
    expect(clientIp(new Headers())).toBeNull();
    expect(clientIp(new Headers({ "x-real-ip": " ", "x-forwarded-for": "" }))).toBeNull();
  });
});
