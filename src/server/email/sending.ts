import { eq } from "drizzle-orm";
import { withTenant } from "../db/client";
import { emailConnections, organizations, users } from "../db/schema";
import { AppError } from "../errors";
import { tenantScope, type OfficeContext } from "../authz/context";
import { audit } from "../services/audit";
import { ownMailbox, startMailboxConnection, type Connection } from "./connections";
import { mailboxCanSend, newMessageId, sendFailure, sendFromMailbox } from "./send";

export const SEND_STATEMENT = "I am authorized to let this app send replies from this mailbox. It sends a reply only after a person approves it and presses Send.";

const setSending = (ctx: OfficeContext, id: string, on: boolean) =>
  withTenant(tenantScope(ctx), async (tx) => {
    const set = on ? { sendEnabledAt: new Date(), sendEnabledBy: ctx.userId } : { sendEnabledAt: null, sendEnabledBy: null };
    await tx.update(emailConnections).set(set).where(eq(emailConnections.id, id));
    await audit(tx, ctx, on ? "mailbox.sending_on" : "mailbox.sending_off", "email_connection", id);
  });

export async function proveSending(ctx: OfficeContext, conn: Connection) {
  if (conn.status !== "active") throw new AppError("validation", "Choose what this mailbox reads first.");
  const [who] = await withTenant(tenantScope(ctx), async (tx) => {
    const [org] = await tx
      .select({ name: organizations.name, legislatorName: organizations.legislatorName })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId));
    const [user] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId));
    return [{ office: org?.legislatorName ?? org?.name ?? null, person: user?.name ?? "A member of staff" }];
  });
  try {
    await sendFromMailbox(conn, {
      fromAddress: conn.emailAddress,
      fromName: who.office,
      to: { address: conn.emailAddress, name: who.office },
      subject: "Constituent Center can send from this mailbox",
      text: [
        `${who.person} turned on sending for ${conn.emailAddress} in Constituent Center.`, "",
        "A reply goes out only after a person approves it and presses Send. This message is what one looks like when it arrives.", "",
        "To turn sending off, open Settings in Constituent Center.",
      ].join("\n"),
      messageId: `cc-test-${newMessageId(conn.emailAddress)}`,
      inReplyTo: null,
      references: [],
    });
  } catch (e) {
    throw new AppError("validation", `Sending was not turned on. ${sendFailure(e)}`, { link: "send_failed" });
  }
  await setSending(ctx, conn.id, true);
}

export async function turnOnSending(ctx: OfficeContext, connectionId: string, acknowledged: boolean): Promise<{ url: string | null }> {
  const conn = await ownMailbox(ctx, connectionId);
  if (!acknowledged) throw new AppError("validation", "Confirm that this app may send replies from this mailbox.");
  if (!mailboxCanSend(conn)) {
    if (conn.status !== "active") throw new AppError("validation", "Choose what this mailbox reads first.");
    if (conn.provider === "imap") throw new AppError("validation", "This mailbox cannot send.");
    return { url: await startMailboxConnection(ctx, conn.provider, true, { sendFor: conn.id }) };
  }
  await proveSending(ctx, conn);
  return { url: null };
}

export async function turnOffSending(ctx: OfficeContext, connectionId: string) {
  const conn = await ownMailbox(ctx, connectionId);
  await setSending(ctx, conn.id, false);
}
