import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { freshDatabase, makeOffice } from "../helpers/db";
import { FakeImap } from "../helpers/fake-imap";
import { LETTERS, OFFICE_ADDRESS, toMime } from "../helpers/office-mailbox";
import { closeDb, withTenant } from "@/server/db/client";
import { classificationRuns, contactAddresses, contactEmails, contacts, emailAttachments, emailMessages, emailThreads, issuePositions, mailLedger, messageAsks,
  messageBillLinks, messageEvents, messageIssueLinks, reviewQueue, templateClusters } from "@/server/db/schema";
import { STAFF_CATEGORIES, staffCategoryOf } from "@/server/classification/categories";
import { DEMO_SESSIONS, demoLegislativeDataset } from "@/server/demo/legislative-fixture";
import { setDistrictLookupForTests } from "@/server/district/lookup";
import { configureMailbox, connectPasswordMailbox, listMailboxFolders } from "@/server/email/connections";
import { setImapOpenerForTests, setMailRecordsForTests } from "@/server/email/providers/imap";
import { FixtureProvider } from "@/server/legislation/providers/fixture";
import { syncJurisdiction } from "@/server/legislation/sync";
import { drainJobs } from "@/server/jobs/runner";
import type { OfficeContext } from "@/server/authz/context";
import { PIPELINE_VERSION } from "@/server/classification/schema";
import { billCorrespondence, listFormLetters, ledgerOverview, needsAPerson, setAskStatus, topics } from "@/server/services/center";
import { rereadOlderReadings } from "@/server/services/classify";
import { setMessageTypes } from "@/server/services/corrections";
import { saveIssue, setIssueActive } from "@/server/services/reading";
import { backgroundJobs } from "@/server/db/schema";
import { systemDb } from "@/server/db/client";
import { listInbox } from "@/server/services/inbox";
import { dismissReview } from "@/server/services/review";

async function everything(orgId: string) {
  return withTenant({ orgId }, async (tx) => {
    const messages = await tx.select().from(emailMessages).where(eq(emailMessages.organizationId, orgId)).orderBy(asc(emailMessages.receivedAt));
    const ledger = await tx.select().from(mailLedger).where(eq(mailLedger.organizationId, orgId));
    const issues = await tx.select().from(messageIssueLinks).where(eq(messageIssueLinks.organizationId, orgId));
    const bills = await tx.select().from(messageBillLinks).where(eq(messageBillLinks.organizationId, orgId));
    const positions = await tx.select().from(issuePositions).where(eq(issuePositions.organizationId, orgId));
    const asks = await tx.select().from(messageAsks).where(eq(messageAsks.organizationId, orgId));
    const people = await tx.select().from(contacts).where(eq(contacts.organizationId, orgId));
    const emails = await tx.select().from(contactEmails).where(eq(contactEmails.organizationId, orgId));
    const addresses = await tx.select().from(contactAddresses).where(eq(contactAddresses.organizationId, orgId));
    const review = await tx.select().from(reviewQueue).where(eq(reviewQueue.organizationId, orgId));
    const runs = await tx.select().from(classificationRuns).where(eq(classificationRuns.organizationId, orgId));
    const clusters = await tx.select().from(templateClusters).where(eq(templateClusters.organizationId, orgId));
    const threads = await tx.select().from(emailThreads).where(eq(emailThreads.organizationId, orgId));
    const attachments = await tx.select().from(emailAttachments).where(eq(emailAttachments.organizationId, orgId));
    const events = await tx.select().from(messageEvents).where(eq(messageEvents.organizationId, orgId));
    return { messages, ledger, issues, bills, positions, asks, people, emails, addresses, review, runs, clusters, threads, attachments, events };
  });
}

let orgId: string;
let ctx: OfficeContext;
let all: Awaited<ReturnType<typeof everything>>;
let box: FakeImap;

const of = (key: string) => all.messages.find((m) => m.rfcMessageId?.startsWith(`${key}@`));

beforeAll(async () => {
  await freshDatabase();
  await syncJurisdiction("GA", { provider: new FixtureProvider(demoLegislativeDataset()), sessionIdentifiers: DEMO_SESSIONS().map((s) => s.identifier) });
  const o = await makeOffice({ jurisdictionCode: "GA", internalDomains: ["house.ga.gov"] });
  orgId = o.orgId;
  ctx = o.ctx;
  setDistrictLookupForTests({ name: "test", locate: async (a) => (/alpharetta/i.test(a) ? { status: "matched", house: "42", senate: "21", city: "Alpharetta" }
    : /roswell/i.test(a) ? { status: "matched", house: "48", senate: "56", city: "Roswell" } : { status: "not_found" }) });
  setMailRecordsForTests({ mx: async () => ["mx.office-mail.example"], txt: async () => [], cname: async () => [], microsoftDirectory: async () => false });
  box = new FakeImap(OFFICE_ADDRESS);
  box.password = "office-app-password";
  setImapOpenerForTests(box.open);
  for (const l of LETTERS) box.addRaw(l.folder ?? "INBOX", toMime(l));
  const linked = await connectPasswordMailbox(o.ctx, { email: OFFICE_ADDRESS, password: "office-app-password", acknowledged: true });
  const sent = (await listMailboxFolders(o.ctx, linked.id)).find((f) => f.isSent)!;
  await configureMailbox(o.ctx, linked.id,
    { folders: [{ id: "INBOX", name: "INBOX" }], importFrom: "2026-01-01", sentFolder: { id: sent.id, name: sent.name } });
  await drainJobs(["mail", "classify"]);
  all = await everything(orgId);

  if (process.env.AUDIT_OUT) {
    const lines = LETTERS.map((l) => {
      const m = of(l.key);
      if (!m) return `## ${l.key}\n  NOT STORED`;
      const mine = <T extends { messageId: string | null }>(rows: T[]) => rows.filter((r) => r.messageId === m.id);
      const person = all.people.find((p) => p.id === m.contactId);
      return [
        `## ${l.key}  [${m.direction}]  ${m.subject}`,
        `  from ${m.fromName} <${m.fromAddress}>  trust=${m.senderTrust}  claimed=${m.claimedAddress ?? "-"}  internal=${m.isInternal}`,
        `  ledger=${mine(all.ledger).map((x) => `${x.disposition}${x.reason ? ` (${x.reason})` : ""}`).join(" | ")}  triage=${m.triageStatus}  priority=${m.priority}  review=${m.requiresReview}  sensitive=${m.isSensitive}  automated=${m.isAutomated} spam=${m.isSpam}`,
        `  kind=${STAFF_CATEGORIES[staffCategoryOf(m.messageTypes, m.isInternal)]}  types=${m.messageTypes.map((t) => `${t}:${m.messageTypeConfidence[t]}`).join(", ")}`,
        `  issues=${mine(all.issues).map((i) => `${i.issueKey}(${i.status})`).join(", ") || "-"}`,
        `  bills=${mine(all.bills).map((b) => `${b.rawReference}->${b.reference} ${b.resolution}/${b.status}${b.billId ? " linked" : ""}`).join(", ") || "-"}`,
        `  positions=${mine(all.positions).map((p) => `${p.targetType}:${p.billReference ?? p.issueKey}=${p.position}${p.requestedAction ? `/${p.requestedAction}` : ""}(${p.status})`).join(", ") || "-"}`,
        `  asks=${mine(all.asks).map((a) => `${a.kind}/${a.urgency}${a.dueAt ? ` due ${a.dueAt.toISOString().slice(0, 10)}` : ""}: ${a.summary}`).join(" | ") || "-"}`,
        `  person=${person ? `${person.fullName} (${person.kind}) district=${person.districtStatus ?? "-"}` : "-"}  thread=${m.threadId?.slice(0, 6)}  cluster=${m.templateClusterId?.slice(0, 6) ?? "-"}  duplicateOf=${m.duplicateOfId ? "yes" : "-"}  note=${m.personalNote ? JSON.stringify(m.personalNote.slice(0, 70)) : "-"}`,
        `  attachments=${mine(all.attachments).map((a) => `${a.filename} ${a.sizeBytes}b ${a.status}`).join(", ") || "-"}  review_items=${mine(all.review).map((r) => `${r.kind}: ${r.reason}`).join(" | ") || "-"}`,
        `  why_review=${JSON.stringify(((all.runs.filter((r) => r.messageId === m.id).at(-1)?.output as { review_reasons?: string[] })?.review_reasons ?? []).join(" | "))}`,
        `  summary=${JSON.stringify(m.summary)}`,
        `  text=${JSON.stringify(m.substantiveText.slice(0, 110))}`,
      ].join("\n");
    });
    const tail = [`\n# totals: messages=${all.messages.length} ledger=${all.ledger.length} people=${all.people.length} threads=${all.threads.length} clusters=${all.clusters.length} runs=${all.runs.length} addresses=${all.addresses.length}`,
      `# people: ${all.people.map((p) => `${p.fullName}/${p.kind}/${p.districtStatus ?? "-"}`).join("; ")}`,
      `# addresses: ${all.addresses.map((a) => `${a.line1}, ${a.city} ${a.state} -> ${a.lookupStatus} ${a.district ?? ""}`).join("; ")}`,
      `# read from Sent: ${box.read.filter((r) => r.startsWith("Sent:")).join(", ")}`];
    writeFileSync(process.env.AUDIT_OUT, [...lines, ...tail].join("\n"));
  }
});
afterAll(async () => {
  setImapOpenerForTests(null);
  setMailRecordsForTests(null);
  setDistrictLookupForTests(undefined);
  await closeDb();
});

const need = (key: string) => {
  const m = of(key);
  if (!m) throw new Error(`${key} was not stored`);
  return m;
};
const mine = <T extends { messageId: string | null }>(rows: T[], key: string) => rows.filter((r) => r.messageId === need(key).id);
const kindOf = (key: string) => STAFF_CATEGORIES[staffCategoryOf(need(key).messageTypes, need(key).isInternal)];
const stances = (key: string) => Object.fromEntries(mine(all.positions, key).filter((p) => p.targetType === "bill").map((p) => [p.billReference, p.position]));
const personOf = (key: string) => all.people.find((p) => p.id === need(key).contactId);

describe("a Georgia office's mailbox, from the raw message to the tags", () => {
  it("stores every message the mailbox holds once, and accounts for each one", async () => {
    const inbox = LETTERS.filter((l) => (l.folder ?? "INBOX") === "INBOX");
    expect(all.messages.filter((m) => m.direction === "inbound")).toHaveLength(inbox.length);
    for (const l of inbox) expect(of(l.key), l.key).toBeDefined();
    expect(all.ledger).toHaveLength(all.messages.length);
    for (const m of all.messages) expect(all.ledger.filter((x) => x.messageId === m.id), m.subject).toHaveLength(1);
    expect(all.messages.every((m) => m.processingStatus === "processed")).toBe(true);
    expect(all.runs.every((r) => r.status === "succeeded" && r.pipelineVersion === PIPELINE_VERSION)).toBe(true);
    expect(all.runs).toHaveLength(all.messages.length);
    const overview = await ledgerOverview(ctx);
    expect(Object.values(overview.byDisposition).reduce((a, b) => a + (b ?? 0), 0)).toBe(all.messages.length);
    expect(overview.byDisposition.failed ?? 0).toBe(0);
  });

  it("reads the office's own reply and leaves its other sent mail alone", () => {
    expect(need("office-reply").direction).toBe("outbound");
    expect(of("unrelated-sent")).toBeUndefined();
    expect(box.read.filter((r) => r.startsWith("Sent:"))).toEqual(["Sent:office-reply@house.ga.gov"]);
    expect(need("office-reply").summary).toMatch(/^Sent by the office\./);
  });

  it("sorts each letter into the pile a staff member would", () => {
    const expected: Record<string, string> = {
      "support-number": "Constituents",
      "oppose-spelled": "Constituents",
      "name-only": "Constituents",
      "typo-number": "Constituents",
      conditional: "Constituents",
      federal: "Constituents",
      "no-bill-stance": "Constituents",
      "casework-ui": "Constituents",
      "casework-es": "Constituents",
      "urgent-eviction": "Constituents",
      safety: "Constituents",
      "two-asks": "Constituents",
      meeting: "Constituents",
      thanks: "Constituents",
      "reply-quoted": "Constituents",
      "forward-only": "Constituents",
      "platform-1": "Constituents",
      "direct-form-1": "Constituents",
      "out-of-state": "Constituents",
      media: "Media",
      vendor: "Vendors",
      lobbyist: "Advocacy and lobbyists",
      agency: "Government",
      internal: "Internal",
      newsletter: "Newsletters",
      autoreply: "Newsletters",
    };
    for (const [key, pile] of Object.entries(expected)) expect(kindOf(key), key).toBe(pile);
    expect(need("casework-ui").messageTypes[0]).toBe("constituent_service");
    expect(need("casework-es").messageTypes[0]).toBe("constituent_service");
    expect(need("meeting").messageTypes[0]).toBe("meeting_request");
    expect(need("thanks").messageTypes[0]).toBe("constituent_general");
    expect(need("two-asks").messageTypes.slice(0, 2).sort()).toEqual(["constituent_policy", "constituent_service"]);
  });

  it("sets newsletters and automatic replies aside and says so in the record", () => {
    for (const key of ["newsletter", "autoreply"]) {
      expect(need(key).triageStatus, key).toBe("archived");
      expect(mine(all.ledger, key)[0].disposition, key).toBe("screened");
      expect(mine(all.asks, key), key).toHaveLength(0);
    }
    expect(personOf("autoreply")?.kind).toBe("person");
  });

  it("matches bills by number, by spelled-out number, by name and through a typo", () => {
    const link = (key: string) => mine(all.bills, key).map((b) => `${b.rawReference}>${b.reference}:${b.resolution}`);
    expect(link("support-number")).toEqual(["HB 142>HB 142:resolved"]);
    expect(link("oppose-spelled")).toEqual(["House Bill 388>HB 388:resolved"]);
    expect(link("name-only")).toEqual(["Rural Broadband Infrastructure>SB 99:resolved"]);
    expect(link("typo-number")).toEqual(["HB 124>HB 142:resolved"]);
    expect(link("attachment")).toEqual(["Early Literacy Coaches>HB 412:resolved"]);
    expect(link("federal")).toEqual(["H.R. 44>HR 44:out_of_jurisdiction"]);
    expect(mine(all.positions, "federal")).toHaveLength(0);
    expect(mine(all.positions, "forward-only").filter((p) => p.targetType === "bill")).toHaveLength(0);
  });

  it("reads where each writer stands", () => {
    expect(stances("support-number")).toEqual({ "HB 142": "support" });
    expect(stances("oppose-spelled")).toEqual({ "HB 388": "oppose" });
    expect(stances("name-only")).toEqual({ "SB 99": "support" });
    expect(stances("typo-number")).toEqual({ "HB 142": "support" });
    expect(stances("conditional")).toEqual({ "SB 18": "mixed" });
    expect(stances("two-asks")).toEqual({ "HB 95": "support" });
    expect(stances("through-filter")).toEqual({ "HB 128": "support" });
    expect(stances("html-only")).toEqual({ "HB 310": "support" });
    expect(stances("attachment")).toEqual({ "HB 412": "support" });
    expect(stances("external-tag")).toEqual({ "SB 18": "oppose" });
    expect(stances("out-of-state")).toEqual({ "HB 77": "oppose" });
    expect(stances("lobbyist")).toEqual({ "HB 77": "support" });
    for (const key of ["platform-1", "platform-2", "platform-3"]) expect(stances(key), key).toEqual({ "SB 112": "support" });
    for (const key of ["direct-form-1", "direct-form-2", "direct-form-3"]) expect(stances(key), key).toEqual({ "HB 230": "support" });
    const pay = mine(all.positions, "no-bill-stance").find((p) => p.issueKey === "education.teacher_pay");
    expect(pay).toMatchObject({ position: "support", status: "needs_review" });
    for (const key of ["media", "vendor", "agency"]) expect(mine(all.positions, key), key).toHaveLength(0);
    expect(mine(all.positions, "support-number")[0].requestedAction).toBe("vote_yes");
    expect(mine(all.positions, "oppose-spelled").find((p) => p.targetType === "bill")?.requestedAction).toBe("vote_no");
  });

  it("keeps one record per person and none for senders nobody confirmed", () => {
    const ann = all.messages.filter((m) => m.fromAddress === "ann.lee@gmail.com" && m.senderTrust === "verified");
    expect(ann).toHaveLength(3);
    expect(new Set(ann.map((m) => m.contactId)).size).toBe(1);
    expect(all.people.filter((p) => p.fullName === "Ann Lee")).toHaveLength(1);
    for (const key of ["forged", "unconfirmed", "internal"]) expect(need(key).contactId, key).toBeNull();
    const viaPlatform = ["platform-1", "platform-2", "platform-3"].map((k) => need(k));
    expect(viaPlatform.map((m) => m.senderTrust)).toEqual(["relay", "relay", "relay"]);
    expect(new Set(viaPlatform.map((m) => m.contactId)).size).toBe(3);
    expect(personOf("platform-1")?.fullName).toBe("Tom Ueda");
    expect(personOf("newsletter")?.kind).toBe("list");
    expect(personOf("vendor")?.kind).toBe("vendor");
    expect(personOf("media")?.kind).toBe("media");
    expect(personOf("agency")?.kind).toBe("agency");
    expect(personOf("thanks")?.kind).toBe("person");
  });

  it("places writers by the address in their letter", () => {
    expect(personOf("support-number")?.districtStatus).toBe("in_district");
    expect(personOf("oppose-spelled")?.districtStatus).toBe("in_district");
    expect(personOf("html-only")?.districtStatus).toBe("in_district");
    expect(personOf("out-of-state")?.districtStatus).toBe("out_of_state");
    expect(personOf("name-only")?.districtStatus ?? null).toBeNull();
  });

  it("holds mail whose sender the mail server did not confirm", async () => {
    expect(need("forged").senderTrust).toBe("failed");
    expect(need("unconfirmed").senderTrust).toBe("unverified");
    expect(need("through-filter").senderTrust).toBe("verified");
    for (const key of ["forged", "unconfirmed"]) {
      expect(mine(all.ledger, key)[0].disposition, key).toBe("held");
      expect(mine(all.review, key).some((r) => r.kind === "sender_check" && r.status === "open"), key).toBe(true);
    }
    const held = await listInbox(ctx, { folder: "held", limit: 50 });
    expect(held.items.map((m) => m.id).sort()).toEqual([need("forged").id, need("unconfirmed").id].sort());
  });

  it("puts a person in danger and a family about to lose their home first", async () => {
    const safety = need("safety");
    expect(safety).toMatchObject({ priority: "urgent", isSensitive: true });
    expect(safety.summary).toMatch(/^The writer may be in danger of harming themselves\./);
    expect(mine(all.asks, "safety").find((a) => a.kind === "safety")).toMatchObject({ urgency: "urgent" });
    const eviction = need("urgent-eviction");
    expect(eviction.priority).toBe("urgent");
    expect(eviction.summary).toMatch(/^Facing eviction\./);
    const due = mine(all.asks, "urgent-eviction").find((a) => a.kind === "deadline");
    expect(due?.urgency).toBe("urgent");
    // "This Friday", counted from the day the letter was written.
    expect(due?.dueAt?.getUTCDay()).toBe(5);
    const board = await needsAPerson(ctx);
    expect(board.urgent[0].messageId).toBe(safety.id);
    expect(board.urgent.map((a) => a.messageId)).toContain(eviction.id);
    expect(board.senders.map((x) => x.messageId).sort()).toEqual([need("forged").id, need("unconfirmed").id].sort());
    const casework = board.casework.map((a) => a.messageId);
    expect(casework).toContain(need("casework-es").id);
    expect(casework).toContain(need("two-asks").id);
    expect(casework).not.toContain(need("casework-ui").id);
    expect(board.others.map((a) => a.messageId)).toContain(need("meeting").id);
  });

  it("suggests the right case for a request for help, in English and in Spanish", () => {
    const suggestion = (key: string) => mine(all.review, key).find((r) => r.kind === "case_suggestion")?.reason;
    expect(suggestion("casework-ui")).toBe("Suggested case: Unemployment insurance (Georgia Department of Labor).");
    expect(suggestion("casework-es")).toBe("Suggested case: Driver services.");
    expect(suggestion("urgent-eviction")).toBe("Suggested case: Housing.");
    expect(suggestion("two-asks")).toBe("Suggested case: Taxes and refunds (Department of Revenue).");
    expect(need("casework-es").language).toBe("es");
  });

  it("keeps a conversation together whatever order the mailbox was read in", () => {
    const thread = need("casework-ui").threadId;
    expect(thread).toBeTruthy();
    expect(need("office-reply").threadId).toBe(thread);
    expect(need("reply-quoted").threadId).toBe(thread);
    expect(all.threads.find((t) => t.id === thread)?.messageCount).toBe(3);
    for (const t of all.threads) expect(all.messages.filter((m) => m.threadId === t.id).length, t.subjectNormalized ?? "").toBe(t.messageCount);
    expect(need("casework-ui").triageStatus).toBe("done");
    expect(mine(all.events, "casework-ui").filter((e) => e.type === "reply_sent")).toHaveLength(1);
    expect(need("reply-quoted").substantiveText).toBe("Thank you, the payment arrived this morning.");
  });

  it("calls the second copy of a letter the repeat, not the first", () => {
    expect(need("support-number").duplicateOfId).toBeNull();
    expect(need("duplicate").duplicateOfId).toBe(need("support-number").id);
    expect(need("forged").duplicateOfId).toBeNull();
  });

  it("reads past the warning line a mail system adds, a forward, HTML and an attachment", () => {
    expect(need("external-tag").substantiveText.startsWith("I oppose SB 18.")).toBe(true);
    expect(need("external-tag").subject).toBe("Medicaid");
    expect(need("forward-only").substantiveText).toBe("");
    expect(need("forward-only").summary).toContain("Forwarded without comment");
    expect(need("html-only").substantiveText).toContain("Please vote for HB 310.");
    expect(mine(all.attachments, "attachment").map((a) => a.filename)).toEqual(["letter.pdf"]);
  });

  it("finds campaigns, and counts each person once", async () => {
    const campaigns = await listFormLetters(ctx);
    expect(campaigns.map((c) => [c.bill, c.stance, c.people, c.withNotes]).sort()).toEqual([
      ["HB 230", "support", 3, 1],
      ["SB 112", "support", 3, 1],
    ]);
    expect(need("support-number").templateClusterId).toBe(need("duplicate").templateClusterId);
    expect(need("platform-3").personalNote).toContain("I am blind");
    expect(need("platform-3").summary).toMatch(/^Form letter with a personal note:/);
    for (const key of ["platform-1", "platform-2", "direct-form-1", "direct-form-2"]) expect(mine(all.asks, key), key).toHaveLength(0);
  });

  it("counts people, not letters, on Topics, and every row adds up", async () => {
    const t = await topics(ctx);
    const bill = (ref: string) => t.bills.find((b) => b.reference === ref);
    expect(bill("SB 112")).toMatchObject({ people: 3, support: 3, oppose: 0, form_letters: 3 });
    expect(bill("HB 230")).toMatchObject({ people: 3, support: 3, oppose: 0, form_letters: 3 });
    // Ann wrote twice, Dee mistyped the number; the forged "no" is not counted.
    expect(bill("HB 142")).toMatchObject({ people: 2, support: 2, oppose: 0, in_district: 1 });
    expect(bill("HB 77")).toMatchObject({ people: 2, support: 1, oppose: 1 });
    expect(bill("SB 18")).toMatchObject({ people: 2, support: 0, oppose: 1, other: 1 });
    expect(bill("HR 44")).toBeUndefined();
    for (const b of t.bills) expect(b.support + b.oppose + b.other, b.reference).toBe(b.people);
    for (const i of t.issues) expect(i.support + i.oppose, i.key).toBeLessThanOrEqual(i.people);
    for (const b of t.bills) expect((await billCorrespondence(ctx, b.reference)).people, b.reference).toBe(b.people);
    const hb142 = await billCorrespondence(ctx, "HB 142");
    expect(hb142.letters.map((l) => l.name).sort()).toEqual(["Ann Lee", "Dee Fox"]);
    expect(hb142.inDistrict).toBe(1);
  });

  it("files each letter under the tabs it belongs in", async () => {
    const tab = async (folder: "all" | "policy" | "service" | "meeting" | "urgent" | "automated" | "done") =>
      (await listInbox(ctx, { folder, limit: 200 })).items.map((m) => m.id);
    const everythingShown = await tab("all");
    for (const key of ["newsletter", "autoreply"]) expect(everythingShown, key).not.toContain(need(key).id);
    expect((await tab("automated")).sort()).toEqual([need("newsletter").id, need("autoreply").id].sort());
    const policy = await tab("policy");
    for (const key of ["support-number", "two-asks", "platform-1", "no-bill-stance"]) expect(policy, key).toContain(need(key).id);
    for (const key of ["vendor", "media", "thanks", "safety", "casework-es"]) expect(policy, key).not.toContain(need(key).id);
    const service = await tab("service");
    for (const key of ["casework-ui", "casework-es", "urgent-eviction", "safety", "two-asks"]) expect(service, key).toContain(need(key).id);
    for (const key of ["support-number", "vendor", "agency"]) expect(service, key).not.toContain(need(key).id);
    expect(await tab("meeting")).toEqual([need("meeting").id]);
    expect((await tab("urgent")).sort()).toEqual([need("safety").id, need("urgent-eviction").id].sort());
    expect(await tab("done")).toEqual([need("casework-ui").id]);
  });
});

describe("reading stored mail again after the reading rules improve", () => {
  it("redoes older readings and keeps everything a person already settled", async () => {
    // Corrections staff made before the update.
    await setMessageTypes(ctx, need("media").id, ["constituent_policy"]);
    const meeting = mine(all.asks, "meeting")[0];
    await setAskStatus(ctx, meeting.id, "handled");
    const question = mine(all.review, "casework-es").find((r) => r.kind === "case_suggestion")!;
    await dismissReview(ctx, question.id);
    // An older reading set a constituent's letter aside as a newsletter.
    await withTenant({ orgId }, async (tx) => {
      await tx.update(emailMessages).set({ triageStatus: "archived", isAutomated: true }).where(eq(emailMessages.id, need("thanks").id));
      await tx.update(mailLedger).set({ disposition: "screened", reason: "Looks like a mailing list or automatic mail." })
        .where(eq(mailLedger.messageId, need("thanks").id));
      await tx.update(classificationRuns).set({ pipelineVersion: "2026.01.1" }).where(eq(classificationRuns.organizationId, orgId));
    });

    expect((await rereadOlderReadings(orgId)).queued).toBe(all.messages.length);
    await drainJobs(["classify"]);
    const after = await everything(orgId);
    const now = (key: string) => after.messages.find((m) => m.id === need(key).id)!;
    const theirs = <T extends { messageId: string | null }>(rows: T[], key: string) => rows.filter((r) => r.messageId === need(key).id);

    expect(after.runs.filter((r) => r.pipelineVersion === PIPELINE_VERSION)).toHaveLength(all.messages.length);
    expect((await rereadOlderReadings(orgId)).queued).toBe(0);
    expect(now("media").messageTypes).toEqual(["constituent_policy"]);
    expect(theirs(after.asks, "meeting").map((a) => a.status)).toEqual(["handled"]);
    expect(theirs(after.review, "casework-es").filter((r) => r.kind === "case_suggestion").map((r) => r.status)).toEqual(["dismissed"]);
    expect(now("thanks")).toMatchObject({ triageStatus: "new", isAutomated: false });
    expect(theirs(after.ledger, "thanks")[0]).toMatchObject({ disposition: "filed", reason: "Read again and returned to the mail." });
    expect(now("casework-ui").triageStatus).toBe("done");
    expect(theirs(after.ledger, "forged")[0].disposition).toBe("held");
    expect(after.people).toHaveLength(all.people.length);
    const t = await topics(ctx);
    expect(t.bills.find((b) => b.reference === "HB 142")).toMatchObject({ people: 2, support: 2, oppose: 0 });
    const [open] = await withTenant({ orgId },
      (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(messageAsks).where(and(eq(messageAsks.organizationId, orgId), eq(messageAsks.status, "open"))));
    expect(open.n).toBe(all.asks.filter((a) => a.status === "open").length - 1);
  });

  it("reads stored mail again when the office changes its issues, and keeps a turned-off issue on old mail", async () => {
    const before = await everything(orgId);
    const tagged = (rows: typeof before, key: string, issue: string) => rows.issues.some((i) => i.messageId === need(key).id && i.issueKey === issue);
    expect(tagged(before, "thanks", "environment.parks")).toBe(false);
    expect(tagged(before, "name-only", "agriculture.broadband")).toBe(true);

    const parks = await saveIssue(ctx, { parentKey: "environment", label: "Parks", keywords: ["Wills Park", "park cleanup"] });
    await setIssueActive(ctx, "agriculture.broadband", false);
    // Saving queues one reread shortly, however many changes were made.
    const db = await systemDb();
    const asked = (await db.select().from(backgroundJobs).where(eq(backgroundJobs.organizationId, orgId)))
      .filter((j) => j.name === "mail.reread" && (j.payload as { changed?: boolean }).changed);
    expect(asked).toHaveLength(1);
    expect(asked[0].runAt.getTime()).toBeGreaterThan(Date.now());

    expect((await rereadOlderReadings(orgId, null, new Date().toISOString())).queued).toBe(before.messages.length);
    await drainJobs(["classify"]);
    const after = await everything(orgId);
    expect(tagged(after, "thanks", parks)).toBe(true);
    expect(tagged(after, "name-only", "agriculture.broadband")).toBe(true);
    expect(after.messages.find((m) => m.id === need("media").id)!.messageTypes).toEqual(["constituent_policy"]);
    expect(after.asks.filter((a) => a.messageId === need("meeting").id).map((a) => a.status)).toEqual(["handled"]);
  });
});
