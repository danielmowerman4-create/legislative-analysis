import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { billFilterOptions } from "@/server/services/legislation";
import { ALERT_KIND_LABEL, alertSearchHref, listAlertRules } from "@/server/services/tools";
import { PageHeader, SepList } from "@/components/ui";
import { Section } from "@/components/ui/blocks";
import { BillNumber } from "@/components/bills";
import { dateOnly } from "@/lib/format";
import { AddAlertForm, AlertRuleControls } from "./controls";

export const metadata: Metadata = { title: "Alerts" };

export default async function AlertsPage() {
  const { ctx } = await requireOffice();
  const [rules, opts] = await Promise.all([listAlertRules(ctx), billFilterOptions(ctx)]);
  const canEdit = can(ctx, "legislation.track");
  const active = rules.filter((r) => r.active).length;

  return (
    <>
      <PageHeader title="Alerts" meta={`${active} active`} />
      <div className="wrap">
        {canEdit && (
          <Section title="Add an alert"><AddAlertForm subjects={opts.subjects} /></Section>
        )}
        <Section title="Your alerts" meta={`${rules.length} saved`}>
          {rules.length === 0 ? (
            <p className="border-y border-line py-5 text-sm text-ink-3">No alerts yet.</p>
          ) : (
            <ul className="flex flex-col">
              {rules.map((r) => (
                <li key={r.id} className="py-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1">
                    <div className="min-w-0">
                      <span className="kicker block text-ink-3">{ALERT_KIND_LABEL[r.kind]}</span>
                      <span className="font-display text-md font-medium text-ink">{r.value}</span>
                    </div>
                    {canEdit && <AlertRuleControls id={r.id} active={r.active} value={r.value} />}
                  </div>
                  <SepList className="tabular mt-1.5 text-sm text-ink-2">
                    <Link href={alertSearchHref(r.kind, r.value)} className="text-ink underline decoration-rule underline-offset-4 hover:text-ink-2">
                      {r.total} {r.total === 1 ? "bill matches" : "bills match"} now
                    </Link>
                    <span>{r.filedSince} filed since this was set</span>
                    <span>Set {dateOnly(r.createdAt)}</span>
                    {!r.active && <span className="font-semibold text-warn-ink">Paused</span>}
                  </SepList>
                  {r.latest.length > 0 && (
                    <ul className="mt-2.5">
                      {r.latest.map((b) => (
                        <li key={b.id} className="py-1">
                          <Link href={`/bills/${b.id}`} className="group flex items-baseline gap-3">
                            <BillNumber identifier={b.identifier} className="w-[72px] shrink-0" />
                            <span className="text-sm text-ink decoration-rule underline-offset-4 group-hover:underline">{b.title}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
