import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { promisify } from "node:util";

const run = promisify(execFile);

// cga.ct.gov omits its intermediate certificate, so Go Daddy's G2 one is supplied.
let ca: string[] | null = null;
function trustedRoots() {
  ca ??= [...rootCertificates, readFileSync(join(process.cwd(), "data", "connecticut", "go-daddy-g2-intermediate.crt"), "utf8")];
  return ca;
}

type CgaResponse = { ok: boolean; status: number; contentType: string; bytes: Uint8Array };

export function fetchFromCga(url: string, method: "GET" | "HEAD" = "GET"): Promise<CgaResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, ca: trustedRoots(), headers: { "user-agent": "LegislativeAnalysis/1.0" }, timeout: 60_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "");
        resolve({ ok: status >= 200 && status < 300, status, contentType, bytes: new Uint8Array(Buffer.concat(chunks)) });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out: ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

export async function listFtpFolder(folder: string) {
  const { stdout } = await run("curl", ["-sS", "--ftp-pasv", "-m", "120", "--list-only", `ftp://ftp.cga.ct.gov/2026/${folder}/`], { maxBuffer: 8_000_000 });
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /\.pdf$/i.test(l));
}

async function withPdf(bytes: Uint8Array, read: (pdf: string) => Promise<string>) {
  const dir = mkdtempSync(join(tmpdir(), "ct-pdf-"));
  try {
    const pdf = join(dir, "in.pdf");
    writeFileSync(pdf, bytes);
    return await read(pdf);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const pdfToLayoutText = (bytes: Uint8Array) =>
  withPdf(bytes, async (pdf) => (await run("pdftotext", ["-layout", pdf, "-"], { maxBuffer: 40_000_000 })).stdout);

export const pdfToXml = (bytes: Uint8Array) =>
  withPdf(bytes, async (pdf) => (await run("pdftohtml", ["-xml", "-i", "-q", "-stdout", pdf], { maxBuffer: 80_000_000 })).stdout);
