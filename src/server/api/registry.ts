import { z } from "zod";

const error = z.object({ error: z.string() });
const csv = z.string().describe("text/csv attachment");

type Route = {
  method: "get" | "post"; path: string; summary: string; auth: string; query?: z.ZodObject; body?: z.ZodType; response: z.ZodType;
  status?: number; errors: Partial<Record<400 | 401 | 403 | 404 | 503, string>>;
};

const ROUTES: Route[] = [
  {
    method: "get", path: "/api/health", summary: "Liveness and database reachability. Reveals no configuration or data.", auth: "none",
    response: z.object({ ok: z.boolean(), db: z.enum(["pg", "pglite"]).optional() }), errors: { 503: "Database unreachable" },
  },
  {
    method: "get", path: "/api/search", summary: "Search bills, legislators and committees in the office's state", auth: "session (legislation.read)",
    query: z.object({ q: z.string().min(2).max(200) }),
    response: z.object({
      results: z.array(z.object({
        type: z.enum(["Bills", "Legislators", "Committees"]), id: z.string(), title: z.string(), subtitle: z.string().optional(), href: z.string(),
      })),
    }),
    errors: { 401: "Not signed in" },
  },
  {
    method: "get", path: "/api/export/tracked", summary: "The office's tracked bills as CSV", auth: "session (legislation.read, reports.read)",
    query: z.object({ position: z.string().optional(), priority: z.string().optional() }), response: csv, errors: { 401: "Not signed in or not allowed" },
  },
  {
    method: "get", path: "/api/export/whip", summary: "Whip count for one bill as CSV", auth: "session (legislation.read)",
    query: z.object({ bill: z.string().describe("bill id"), chamber: z.enum(["upper", "lower"]).optional() }), response: csv,
    errors: { 400: "No bill given", 401: "Not signed in", 404: "Bill not found" },
  },
  {
    method: "get", path: "/api/export/calendar",
    summary: "Hearings and the office's own calendar entries from yesterday through the next 60 days as an iCalendar file",
    auth: "session (legislation.read)", query: z.object({ scope: z.enum(["mine", "all", "tracked"]).optional() }),
    response: z.string().describe("text/calendar attachment"), errors: { 401: "Not signed in" },
  },
  {
    method: "get", path: "/constituent-center/export/{kind}", summary: "Constituent Center CSV: mail (every letter) or bills (positions per bill)",
    auth: "session (inbox.read, records.export), Constituent Center on", response: csv,
    errors: { 401: "Not signed in, not allowed, or Constituent Center off", 404: "Unknown kind" },
  },
  {
    method: "post", path: "/api/webhooks/gmail", summary: "Google Pub/Sub push for Gmail. Verified by OIDC token; enqueues an incremental sync.",
    auth: "Pub/Sub OIDC bearer token",
    body: z.object({
      message: z.object({ data: z.string().describe("base64 JSON {emailAddress, historyId}"), messageId: z.string() }), subscription: z.string(),
    }),
    response: z.null(), status: 204, errors: { 400: "Malformed push", 401: "Token missing or invalid" },
  },
  {
    method: "post", path: "/api/webhooks/microsoft", summary: "Microsoft Graph change and lifecycle notifications. Echoes validationToken; checks clientState.",
    auth: "per-subscription clientState", query: z.object({ validationToken: z.string().optional() }),
    body: z.object({
      value: z.array(z.object({
        subscriptionId: z.string(), clientState: z.string().optional(), changeType: z.string().optional(), resource: z.string().optional(),
        lifecycleEvent: z.string().optional(),
      })),
    }),
    response: z.null(), status: 202, errors: { 400: "Malformed notification", 403: "Every notification rejected" },
  },
  {
    method: "get", path: "/api/integrations/{provider}/callback",
    summary: "Mailbox sign-in redirect (google | microsoft), bound to the user who started it by a signed state. Redirects to Constituent Center setup.",
    auth: "session + OAuth state", query: z.object({ code: z.string(), state: z.string() }), response: z.null(), status: 302, errors: {},
  },
  {
    method: "get", path: "/api/integrations/microsoft/approval", summary: "Sends an outside IT administrator to Microsoft's approval page for this app",
    auth: "none", response: z.null(), status: 302, errors: { 404: "Outlook sign-in not set up on this server" },
  },
];

const json = (schema: z.ZodType) => ({ "application/json": { schema: z.toJSONSchema(schema, { unrepresentable: "any" }) } });

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const status = r.status ?? 200;
    const ok = status === 200 ? { description: "OK", content: json(r.response) } : { description: status === 302 ? "Redirect" : "Accepted" };
    const failures = Object.fromEntries(Object.entries(r.errors).map(([code, description]) => [code, { description, content: json(error) }]));
    const op: Record<string, unknown> = { summary: r.summary, description: `Authentication: ${r.auth}.`, responses: { [status]: ok, ...failures } };
    if (r.query) {
      op.parameters = Object.entries(r.query.shape).map(([name, s]) => ({
        name, in: "query", required: !(s as z.ZodType).safeParse(undefined).success, schema: z.toJSONSchema(s as z.ZodType, { unrepresentable: "any" }),
      }));
    }
    if (r.body) op.requestBody = { content: json(r.body) };
    paths[r.path] = { ...paths[r.path], [r.method]: op };
  }
  return { openapi: "3.1.0", info: { title: "Legislative Analysis HTTP API", version: "0.1.0" }, paths };
}
