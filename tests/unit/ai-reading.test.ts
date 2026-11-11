// The real Claude reader against a local stand-in for the Messages API, merged with the rules by the real pipeline.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPipeline, type PipelineDeps } from "@/server/classification/pipeline";
import { flattenTaxonomy } from "@/server/classification/default-taxonomy";
import { resetEnvForTests } from "@/server/env";

type Request = { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> };
let server: Server;
let seen: Request;
let reply: "answer" | "refusal" | "error" = "answer";

const ANSWER = {
  message_types: [{ type: "constituent_policy", confidence: 0.95 }], summary: "Asks the representative to support HB 142.",
  issues: [{ taxonomy_id: "education.school_funding", confidence: 0.92, evidence_quote: "our schools need the new funding formula" }],
  positions: [{ target: "bill:HB 142", position: "support", confidence: 0.96, evidence_quote: "I support HB 142", requested_action: "vote_yes" }],
  requested_actions: [], asks: [],
};

function respond(): [number, unknown] {
  if (reply === "error") return [500, { type: "error", error: { type: "api_error", message: "down" } }];
  const refused = reply === "refusal";
  return [200, {
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null,
    stop_reason: refused ? "refusal" : "end_turn", stop_details: refused ? { type: "refusal", category: null, explanation: null } : null,
    content: refused ? [] : [{ type: "text", text: JSON.stringify(ANSWER) }],
    usage: { input_tokens: 1200, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }];
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen = { headers: req.headers, body: JSON.parse(raw) };
      const [status, body] = respond();
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resetEnvForTests();
});

afterAll(() => {
  server.close();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  resetEnvForTests();
});

const BODY = "Dear Representative,\n\nI support HB 142 because our schools need the new funding formula. My SSN is 123-45-6789.\n\nPat Jones";
const HB142 = {
  id: "00000000-0000-4000-8000-000000000142", identifier: "HB 142", jurisdictionCode: "ZZ", sessionIdentifier: "2025-2026", sessionStart: "2025-01-13",
  sessionEnd: "2026-04-30", title: "School Funding Formula Revision Act", subjects: ["Education"], sponsorNames: [],
};

async function read() {
  const { AnthropicProvider } = await import("@/server/ai/anthropic");
  const deps: PipelineDeps = {
    taxonomy: flattenTaxonomy(), officeJurisdiction: "ZZ", office: { internalDomains: ["house.example.gov"], legislatureDomains: [], agencies: [] },
    thresholds: { issue: 0.85, position: 0.9, billMatch: 0.95, messageType: 0.8 }, findBillCandidates: async () => [HB142], ai: new AnthropicProvider(),
  };
  const envelope = {
    fromAddress: "pat@mail.test", fromName: "Pat Jones", subject: "HB 142, SSN 123-45-6789", headers: {}, labels: [], direction: "inbound" as const,
    sentAt: new Date("2026-02-10T15:00:00Z"),
  };
  const { result } = await runPipeline({ envelope, bodyText: BODY, bodyHtml: null }, deps);
  return { status: result.ai_status, hb142: result.positions.find((p) => p.bill_reference === "HB 142") };
}

describe("reading mail with Claude", () => {
  it("sends a masked, well-formed request and merges Claude's reading with the rules", async () => {
    reply = "answer";
    const r = await read();
    const body = seen.body as { model: string; fallbacks: string; output_config: { format: { type: string } }; messages: unknown };
    expect(body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { format: { type: "json_schema" } } });
    expect(String(seen.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(JSON.stringify(body.messages)).not.toContain("123-45-6789");
    expect(r.status).toBe("ok");
    expect(r.hb142).toMatchObject({ position: "support", source: "ensemble" });
  });

  it("keeps the rules' reading when Claude refuses or is unavailable", async () => {
    for (const mode of ["refusal", "error"] as const) {
      reply = mode;
      const r = await read();
      expect(r.status).toBe("failed");
      expect(r.hb142).toMatchObject({ position: "support", source: "rule" });
    }
  });
});
