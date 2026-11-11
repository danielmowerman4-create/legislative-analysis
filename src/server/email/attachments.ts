import { createHash } from "node:crypto";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const BLOCKED_EXT = /\.(exe|com|bat|cmd|scr|pif|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|msi|msp|dll|jar|hta|lnk|iso|img|vhd|reg|cpl|docm|xlsm|pptm|dotm|xlam|apk|sh|app|dmg)$/i;

function sniffType(b: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x50, 0x4b, 0x03, 0x04)) return "application/zip";
  if (starts(0x4d, 0x5a)) return "application/x-msdownload";
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) return "application/x-ole-storage";
  if (starts(0x7f, 0x45, 0x4c, 0x46)) return "application/x-executable";
  return null;
}

export type AttachmentDecision = { status: "blocked" | "skipped"; reason: string; sniffed: string | null; sha256: string; storageKey: null };

export function inspectAttachment(filename: string, declaredType: string, content: Uint8Array): AttachmentDecision {
  const sha256 = createHash("sha256").update(content).digest("hex");
  const sniffed = sniffType(content);
  const base = { sniffed, sha256, storageKey: null };
  const blocked = (reason: string) => ({ status: "blocked" as const, reason, ...base });
  if (BLOCKED_EXT.test(filename)) return blocked("Executable or macro-enabled file type");
  if (sniffed === "application/x-msdownload" || sniffed === "application/x-executable") return blocked("File content is an executable");
  if (sniffed === "application/pdf" && !/pdf/i.test(declaredType) && !/\.pdf$/i.test(filename)) return blocked("Declared type does not match content");
  const reason =
    content.byteLength > MAX_ATTACHMENT_BYTES ? "Larger than 25 MB; open it in the mailbox" : "Stays in the mailbox until malware scanning is connected";
  return { status: "skipped", reason, ...base };
}
