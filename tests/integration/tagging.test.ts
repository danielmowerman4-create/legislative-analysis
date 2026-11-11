import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connectFakeGmail } from "../helpers/mailbox";
import { freshDatabase, makeOffice } from "../helpers/db";
import { receive } from "../helpers/messages";
import { closeDb, withTenant } from "@/server/db/client";
import { bills, issuePositions, messageBillLinks } from "@/server/db/schema";
import { listMailboxFolders } from "@/server/email/connections";
import { GraphClient } from "@/server/email/providers/graph";
import { setProviderFetchForTests } from "@/server/email/providers/http";
import { drainJobs } from "@/server/jobs/runner";
import { DEMO_SESSIONS, demoLegislativeDataset } from "@/server/demo/legislative-fixture";
import { FixtureProvider } from "@/server/legislation/providers/fixture";
import { syncJurisdiction } from "@/server/legislation/sync";
import { enableConstituentCenter } from "@/server/services/center";
import { classifyMessage } from "@/server/services/classify";
import { setBillLink, setIssueLabel } from "@/server/services/corrections";
import { getMessageDetail, listInbox, listIssueOptions } from "@/server/services/inbox";

beforeAll(async () => {
  await freshDatabase();
  await syncJurisdiction("ZZ", { provider: new FixtureProvider(demoLegislativeDataset()), sessionIdentifiers: DEMO_SESSIONS().map((s) => s.identifier) });
});
afterAll(() => closeDb());

async function office() {
  const o = await makeOffice();
  await enableConstituentCenter(o.orgId);
  return o;
}
const classifyAll = () => drainJobs(["classify"]);
const billNamed = async (orgId: string, identifier: string) =>
  (await withTenant({ orgId }, (tx) => tx.select().from(bills).where(eq(bills.identifier, identifier)))).filter((b) => b.title)[0];
const links = (orgId: string, messageId: string) =>
  withTenant({ orgId }, (tx) => tx.select().from(messageBillLinks).where(eq(messageBillLinks.messageId, messageId)));
const live = (rows: { status: string }[]) => rows.filter((r) => r.status !== "rejected");

describe("tagging a message", () => {
  it("tags any bill in session from its name, and shows it on the list", async () => {
    const o = await office();
    const r = await receive(o.orgId,
      { from: "ann@mail.test", name: "Ann", subject: "Buses", body: "Please pass the Public Transit Capital Fund. Our town depends on it." });
    await classifyAll();
    const [link] = await links(o.orgId, r.messageId);
    const sb = await billNamed(o.orgId, link.reference);
    expect(sb.title).toBe("Public Transit Capital Fund");
    expect(link).toMatchObject({ billId: sb.id, resolution: "resolved" });
    const list = await listInbox(o.ctx, {});
    expect(list.items.find((m) => m.id === r.messageId)?.bills[0]).toMatchObject({ reference: link.reference, linked: true });
  });

  it("corrects a mistyped number from what the letter says, and files the stance under the real bill", async () => {
    const o = await office();
    const r = await receive(o.orgId,
      { from: "ben@mail.test", name: "Ben", body: "I am writing to support HB 124. The school funding formula needs revision this year." });
    await classifyAll();
    const hb = await billNamed(o.orgId, "HB 142");
    const [link] = await links(o.orgId, r.messageId);
    expect(link).toMatchObject({ reference: "HB 142", rawReference: "HB 124", billId: hb.id });
    const positions = await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(issuePositions).where(eq(issuePositions.messageId, r.messageId)));
    expect(positions.find((p) => p.targetType === "bill")).toMatchObject({ billReference: "HB 142", position: "support", billId: hb.id });
  });

  it("lets staff settle a mistyped number, which stays settled when the mail is read again", async () => {
    const o = await office();
    const r = await receive(o.orgId, { from: "cy@mail.test", name: "Cy", body: "I support HB 124." });
    await classifyAll();
    const hb = await billNamed(o.orgId, "HB 142");
    const [before] = await links(o.orgId, r.messageId);
    expect(before).toMatchObject({ reference: "HB 124", billId: null, resolution: "ambiguous" });
    expect(before.candidateBillIds).toContain(hb.id);

    await setBillLink(o.ctx, r.messageId, "HB 124", hb.id);
    await classifyMessage(o.orgId, r.messageId);

    const after = live(await links(o.orgId, r.messageId));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ reference: "HB 142", rawReference: "HB 124", billId: hb.id, status: "confirmed" });
    const positions = await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(issuePositions).where(eq(issuePositions.messageId, r.messageId)));
    expect(positions.filter((p) => p.targetType === "bill").map((p) => p.billReference)).toEqual(["HB 142"]);
  });

  it("lets staff add a bill the message never named", async () => {
    const o = await office();
    const r = await receive(o.orgId, { from: "di@mail.test", name: "Di", body: "Please help with the road near my house." });
    await classifyAll();
    const hb = await billNamed(o.orgId, "HB 142");
    await setBillLink(o.ctx, r.messageId, "HB 142", hb.id);
    expect(live(await links(o.orgId, r.messageId))).toHaveLength(1);
  });

  it("lets staff add and remove an issue, and a re-read does not undo either", async () => {
    const o = await office();
    const r = await receive(o.orgId, { from: "ed@mail.test", name: "Ed", subject: "Potholes", body: "The road maintenance on my street is terrible." });
    await classifyAll();
    const options = await listIssueOptions(o.ctx);
    expect(options.some((x) => x.key === "education.school_funding" && x.parentKey === "education")).toBe(true);

    await setIssueLabel(o.ctx, r.messageId, "education.school_funding", "confirm");
    await setIssueLabel(o.ctx, r.messageId, "transportation.road_maintenance", "reject");
    await classifyMessage(o.orgId, r.messageId);

    const d = await getMessageDetail(o.ctx, r.messageId);
    const statusOf = (key: string) => d.issues.find((i) => i.key === key)?.status;
    expect(statusOf("education.school_funding")).toBe("confirmed");
    expect(statusOf("transportation.road_maintenance")).toBe("rejected");
    const tagged = await listInbox(o.ctx, { issue: "education.school_funding" });
    expect(tagged.items.map((m) => m.id)).toEqual([r.messageId]);
  });
});

describe("choosing what a mailbox reads", () => {
  it("lists subfolders by their full name", async () => {
    setProviderFetchForTests(async (url) => {
      if (url.includes("/childFolders")) {
        return new Response(JSON.stringify({ value: [{ id: "c", displayName: "Constituents", totalItemCount: 1, childFolderCount: 0 }] }));
      }
      return new Response(JSON.stringify({ value: [{ id: "i", displayName: "Inbox", totalItemCount: 9, childFolderCount: 1 },
        { id: "s", displayName: "Sent Items", totalItemCount: 2, childFolderCount: 0 }] }));
    });
    const folders = await new GraphClient(async () => "t", "office@house.ga.gov").listFolders();
    setProviderFetchForTests(null);
    expect(folders.map((f) => f.displayName)).toEqual(["Inbox", "Sent Items", "Inbox / Constituents"]);
  });

  it("marks which folder is the general inbox", async () => {
    const o = await office();
    const { conn } = await connectFakeGmail(o.orgId, o.ctx.userId);
    const folders = await listMailboxFolders(o.ctx, conn.id);
    setProviderFetchForTests(null);
    expect(folders.filter((f) => f.isInbox).map((f) => f.id)).toEqual(["INBOX"]);
  });
});
