import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "./env";

function keyring(): Map<string, Buffer> {
  const env = getEnv();
  const ring = new Map<string, Buffer>([[env.TOKEN_ENCRYPTION_KEY_ID, Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64")]]);
  for (const entry of (env.TOKEN_ENCRYPTION_OLD_KEYS ?? "").split(",").filter(Boolean)) {
    const [id, b64] = entry.split(":");
    if (id && b64) ring.set(id, Buffer.from(b64, "base64"));
  }
  return ring;
}

export function encryptSecret(plaintext: string): string {
  const env = getEnv();
  const key = keyring().get(env.TOKEN_ENCRYPTION_KEY_ID)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [env.TOKEN_ENCRYPTION_KEY_ID, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(payload: string): string {
  const [keyId, iv, tag, ct] = payload.split(".");
  const key = keyring().get(keyId);
  if (!key || !iv || !tag || ct === undefined) throw new Error("Unreadable secret (unknown key or malformed payload)");
  // Full-length tag only: a shortened one is far easier to forge.
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export const sha256 = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

function hmac(input: string) {
  return createHmac("sha256", getEnv().SESSION_SECRET).update(input).digest("base64url");
}

export const hashIp = (ip: string | null | undefined) => (ip ? hmac(`ip:${ip}`).slice(0, 22) : null);

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
