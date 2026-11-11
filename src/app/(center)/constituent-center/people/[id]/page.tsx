import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { orNotFound } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { getContactDetail } from "@/server/services/contacts";
import { BackLink, DistrictWord, ROOT } from "@/components/center/parts";
import { AddressForm, DistrictControls, PersonNote } from "@/components/center/controls";
import { shortDate } from "@/lib/format";

const DISTRICT_SOURCE: Record<string, string> = { staff: "Set by staff", address_lookup: "Found from their address",
  address: "From the state in their address" };
const LOOKUP_WORD: Record<string, string> = { pending: "Not looked up yet.", matched: "Placed in a district.", not_found: "Could not be placed in a district.",
  out_of_state: "Another state.", skipped: "Not looked up." };

const STANCE: Record<string, string> = { support: "Supports", oppose: "Opposes", mixed: "Mixed on", neutral: "Asked about" };
const KIND: Record<string, string> = { email_in: "Wrote in", email_out: "Office replied", case: "Case", note: "Note", task: "Task" };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireCenter();
  if (!can(ctx, "contacts.read")) notFound();
  const { id } = await params;
  const d = await orNotFound(getContactDetail(ctx, id));
  const c = d.contact;
  const canWrite = can(ctx, "contacts.write");
  // One line a bill: the latest side they took, else the latest mention.
  const stated = (p: { position: string }) => p.position === "support" || p.position === "oppose" || p.position === "mixed";
  const byBill = new Map<string, (typeof d.positions)[number]>();
  for (const p of d.positions.filter((x) => x.targetKey.startsWith("bill:"))) {
    const held = byBill.get(p.targetKey);
    if (!held || (!stated(held) && stated(p))) byBill.set(p.targetKey, p);
  }
  const billStances = [...byBill.values()];
  return (
    <article className="pt-6">
      <BackLink href={`${ROOT}/people`}>People</BackLink>
      <div className="mt-5 grid gap-x-14 gap-y-10 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <h1 className="anchor text-[60px] text-ink lg:text-[84px]">{c.fullName ?? c.organizationName ?? d.emails[0]?.email ?? "No name recorded"}</h1>
          <ol className="mt-6">
            {d.timeline.map((t) => (
              <li key={`${t.kind}-${t.id}`} className="grid gap-x-8 gap-y-1 border-b border-line py-4 md:grid-cols-[110px_minmax(0,1fr)]">
                <p className="text-sm text-ink-3">{shortDate(t.at)}</p>
                <div className="min-w-0">
                  <p className="text-sm text-ink-2">{KIND[t.kind]}</p>
                  <Link href={t.href} className="text-base font-semibold text-ink transition-colors hover:text-ink-2">{t.title}</Link>
                  {t.detail && <p className={t.kind === "note" ? "hand" : "line-clamp-2 text-sm text-ink-2"}>{t.detail}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
        <aside className="flex min-w-0 flex-col gap-6">
          <div>
            <h2 className="display text-[24px] text-ink">Email</h2>
            <ul className="mt-2 text-base text-ink">
              {d.emails.map((e) => (
                <li key={e.id}>{e.email} <span className="text-sm text-ink-2">{e.verified ? "Confirmed" : "Given by a platform, not confirmed"}</span></li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="display text-[24px] text-ink">District</h2>
            <div className="mt-2 text-base text-ink">
              {canWrite ? (
                <DistrictControls id={c.id} status={c.districtStatus} />
              ) : c.districtStatus ? (
                <DistrictWord status={c.districtStatus} />
              ) : "Not known"}
            </div>
            {c.districtSource && <p className="mt-1 text-sm text-ink-2">{DISTRICT_SOURCE[c.districtSource] ?? c.districtSource}</p>}
          </div>
          <div>
            <h2 className="display text-[24px] text-ink">Address</h2>
            <ul className="mt-2 flex flex-col gap-2 text-base text-ink">
              {d.addresses.map((a) => (
                <li key={a.id}>
                  {a.line1}, {a.city}, {a.state} {a.postalCode}
                  <p className="text-sm text-ink-2">{a.source === "email" ? "From their email" : "Added by staff"}. {LOOKUP_WORD[a.lookupStatus]}</p>
                </li>
              ))}
              {d.addresses.length === 0 && <li className="text-ink-2">None on record</li>}
            </ul>
            {canWrite && (
              <div className="mt-3"><AddressForm id={c.id} /></div>
            )}
          </div>
          {billStances.length > 0 && (
            <div>
              <h2 className="display text-[24px] text-ink">Has written about</h2>
              <ul className="mt-2 text-base text-ink">
                {billStances.map((p) => (
                  <li key={p.targetKey}>{STANCE[p.position] ?? "Wrote about"} {p.targetKey.slice(5)}</li>
                ))}
              </ul>
            </div>
          )}
          {canWrite && (
            <div>
              <h2 className="display text-[24px] text-ink">Add a note</h2>
              <div className="mt-2"><PersonNote id={c.id} kind="contact" /></div>
            </div>
          )}
        </aside>
      </div>
    </article>
  );
}
