import { and, eq } from "drizzle-orm";
import { withTenant, type Db } from "../db/client";
import { contactAddresses, contacts, emailMessages, officeSettings, organizations, type DistrictStatus } from "../db/schema";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { findWriterAddress, formatAddress, normalizeAddress, normalizeDistrict, parseAddress, type ParsedAddress } from "../district/address";
import { districtLookupFor } from "../district/lookup";
import { AppError, notFound } from "../errors";
import { enqueue } from "../jobs/queue";
import { audit } from "./audit";

async function saveAddress(tx: Db, orgId: string, contactId: string, a: ParsedAddress, source: string, messageId: string | null) {
  const [row] = await tx.insert(contactAddresses)
    .values({
      organizationId: orgId, contactId, line1: a.line1, city: a.city, state: a.state, postalCode: a.postalCode, source, normalized: normalizeAddress(a),
      messageId,
    })
    .onConflictDoNothing().returning({ id: contactAddresses.id });
  if (row) await enqueue("contact.locate", { addressId: row.id }, { orgId, idempotencyKey: `locate:${row.id}` }, tx);
  return row?.id ?? null;
}

// Only a confirmed sender's own address may move anyone's district.
export async function recordWriterAddress(
  tx: Db, orgId: string, msg: Pick<typeof emailMessages.$inferSelect, "id" | "contactId" | "direction" | "senderTrust" | "isInternal">,
  pre: { substantive: string; signature: string | null },
) {
  if (!msg.contactId || msg.direction !== "inbound" || msg.isInternal || (msg.senderTrust !== "verified" && msg.senderTrust !== "relay")) return;
  const a = findWriterAddress(pre);
  if (a) await saveAddress(tx, orgId, msg.contactId, a, "email", msg.id);
}

// Staff's word stands: a lookup never replaces a district a person set.
export async function locateAddress(orgId: string, addressId: string) {
  const loaded = await withTenant({ orgId }, async (tx) => {
    const [addr] = await tx.select().from(contactAddresses).where(and(eq(contactAddresses.id, addressId), eq(contactAddresses.organizationId, orgId)));
    if (!addr || addr.lookupStatus !== "pending") return null;
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, addr.contactId));
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
    const [settings] = await tx.select({ enabled: officeSettings.addressLookupEnabled }).from(officeSettings).where(eq(officeSettings.organizationId, orgId));
    return { addr, contact, org, enabled: Boolean(settings?.enabled) };
  });
  if (!loaded) return { skipped: "not pending" };
  const { addr, contact, org, enabled } = loaded;

  const settle = (values: Partial<typeof contactAddresses.$inferInsert>, person?: Partial<typeof contacts.$inferInsert>) =>
    withTenant({ orgId }, async (tx) => {
      await tx.update(contactAddresses).set({ ...values, lookedUpAt: new Date() }).where(eq(contactAddresses.id, addressId));
      if (person && contact.districtSource !== "staff") await tx.update(contacts).set(person).where(eq(contacts.id, contact.id));
    });

  if (addr.state !== org.jurisdictionCode) {
    await settle({ lookupStatus: "out_of_state" }, contact.districtStatus ? undefined : { districtStatus: "out_of_state", districtSource: "address" });
    return { status: "out_of_state" };
  }
  if (!enabled) return { skipped: "lookup off" };
  const lookup = await districtLookupFor(org);
  if (!lookup) return { skipped: "no lookup configured" };
  if (org.chamber === "other" || !org.district) {
    await settle({ lookupStatus: "skipped" });
    return { skipped: "office has no district" };
  }

  const answer = await lookup.locate(formatAddress({
    line1: addr.line1 ?? "", city: addr.city ?? "", state: addr.state ?? "", postalCode: addr.postalCode ?? "",
  }));
  const district = answer.status === "matched" ? (org.chamber === "upper" ? answer.senate : answer.house) : null;
  if (answer.status !== "matched" || !district) {
    await settle({ lookupStatus: "not_found" });
    return { status: "not_found" };
  }
  const inDistrict = district === normalizeDistrict(org.district);
  await settle(
    { lookupStatus: "matched", district, verifiedAt: new Date() },
    contact.districtStatus ? undefined
      : {
        district, districtStatus: inDistrict ? "in_district" : "outside", districtSource: "address_lookup", districtVerifiedAt: new Date(),
        municipality: contact.municipality ?? answer.city,
      },
  );
  return { status: "matched", inDistrict };
}

export async function setContactDistrict(ctx: OfficeContext, contactId: string, status: DistrictStatus | null) {
  requirePermission(ctx, "contacts.write");
  await withTenant(tenantScope(ctx), async (tx) => {
    const [org] = await tx.select({ district: organizations.district }).from(organizations).where(eq(organizations.id, ctx.orgId));
    const [c] = await tx.update(contacts)
      .set({
        districtStatus: status, district: status === "in_district" ? org.district : null, districtSource: status ? "staff" : null,
        districtVerifiedAt: status ? new Date() : null,
      })
      .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.orgId))).returning({ id: contacts.id });
    if (!c) throw notFound("Person not found.");
    await audit(tx, ctx, "contact.district_set", "contact", contactId, { status });
  });
}

export async function addContactAddress(ctx: OfficeContext, contactId: string, text: string) {
  requirePermission(ctx, "contacts.write");
  const a = parseAddress(text.trim());
  if (!a) throw new AppError("validation", "Enter a full street address, such as 12 Main St, Alpharetta, GA 30009.");
  await withTenant(tenantScope(ctx), async (tx) => {
    const [c] = await tx.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.orgId)));
    if (!c) throw notFound("Person not found.");
    await saveAddress(tx, ctx.orgId, contactId, a, "staff", null);
    await audit(tx, ctx, "contact.address_added", "contact", contactId);
  });
}
