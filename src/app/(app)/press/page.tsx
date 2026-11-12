import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { listPress, PRESS_KIND_LABEL, pressBillOptions } from "@/server/services/press";
import { PRESS_KINDS } from "@/server/db/schema";
import { PageHeader, Status } from "@/components/ui";
import { Section } from "@/components/ui/blocks";
import { relative } from "@/lib/format";
import { NewStatement } from "./controls";

export const metadata: Metadata = { title: "Press" };

export default async function PressPage() {
  const { ctx } = await requireOffice();
  const canDraft = can(ctx, "communications.draft");
  const [items, bills] = await Promise.all([listPress(ctx), canDraft ? pressBillOptions(ctx) : []]);
  return (
    <>
      <PageHeader title="Press" meta={`${items.length} ${items.length === 1 ? "statement" : "statements"}`} />
      <div className="wrap">
        {canDraft && (
          <Section title="New statement"><NewStatement kinds={PRESS_KINDS.map((k) => [k, PRESS_KIND_LABEL[k]])} bills={bills} /></Section>
        )}
        <Section title="Statements">
          {items.length === 0 ? (
            <p className="border-y border-line py-5 text-sm text-ink-3">No statements yet.</p>
          ) : (
            <ul className="-mt-3 flex flex-col">
              {items.map((p) => (
                <li key={p.id} className="grid items-baseline gap-x-8 gap-y-1 py-4 sm:grid-cols-[minmax(0,1fr)_120px_190px]">
                  <Link href={`/press/${p.id}`} className="font-display text-lg font-medium text-ink decoration-rule underline-offset-4 hover:underline">
                    {p.headline}
                  </Link>
                  <Status tone={p.status === "approved" ? "ok" : "neutral"}>{p.status === "approved" ? "Approved" : "Draft"}</Status>
                  <span className="text-sm text-ink-2">{p.author ?? "Staff"}, {relative(p.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
