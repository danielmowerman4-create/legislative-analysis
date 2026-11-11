import { htmlToText } from "../classification/preprocess";

export async function extractDocumentText(bytes: Uint8Array, mime: string | null): Promise<string | null> {
  const type = (mime ?? "").toLowerCase();
  if (type.includes("html")) return htmlToText(Buffer.from(bytes).toString("utf8"));
  if (type.includes("text/plain")) return Buffer.from(bytes).toString("utf8");
  if (type.includes("pdf") || (bytes[0] === 0x25 && bytes[1] === 0x50)) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
  }
  return null;
}
