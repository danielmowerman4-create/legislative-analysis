import type { Metadata } from "next";
import { Download } from "lucide-react";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { POSITION_LABEL, PRIORITY_LABEL, sessionState, trackedReport } from "@/server/services/legislation";
import { STATUS_LABEL } from "@/server/legislation/normalize";
import { statusStep } from "@/server/legislation/stages";
import type { BillPosition, BillPriority } from "@/server/db/schema";
import { ActionLink, EmptyState, Notice, PageHeader } from "@/components/ui";
import { Section, Segmented } from "@/components/ui/blocks";
import { BillList } from "@/components/bills";
import { PositionButtons, TrackingExtras } from "../bills/controls";
import { dateOnly, dayKey } from "@/lib/format";

export const metadata: Metadata = { title: "Tracked bills" };

const GROUPS = { position: "Position", stage: "Status", priority: "Priority", committee: "Committee" } as const;
type Group = keyof typeof GROUPS;
const POSITIONS = Object.keys(POSITION_LABEL) as BillPosition[];
const POSITION_TONE: Record<BillPosition, string> = { support: "text-support", oppose: "text-oppose", neutral: "text-neutral", watching: "text-ink-2" };

type TrackedPageProps = { searchParams: Promise<{ group?: string; position?: string; priority?: string; mine?: string }> };

export default async function TrackedPage({ searchParams }: TrackedPageProps) {
  const { ctx } = await requireOffice();
  if (!can(ctx, "reports.read")) return <div className="wrap py-10"><Notice title="You do not have access to the office's tracked bills." /></div>;
  const sp = await searchParams;
  const group = (sp.group && Object.hasOwn(GROUPS, sp.group) ? sp.group : "position") as Group;
  const filters = { position: sp.position, priority: sp.priority, assignedTo: sp.mine ? ctx.userId : undefined };
  const [rows, session] = await orNotFound(Promise.all([trackedReport(ctx, filters), sessionState(ctx)]));
  const canEdit = can(ctx, "legislation.track");
  const canExport = can(ctx, "records.export") || can(ctx, "reports.read");
  const today = dayKey(new Date());

  const keyOf = (r: (typeof rows)[number]) => group === "position" ? r.position : group === "priority" ? r.priority : group === "stage" ? r.status
    : (r.committee ?? "No committee");
  const order = (k: string) => {
    if (group === "position") return Object.keys(POSITION_LABEL).indexOf(k);
    if (group === "priority") return Object.keys(PRIORITY_LABEL).indexOf(k);
    return group === "stage" ? -statusStep(k as never) : 0;
  };
  const label = (k: string) => {
    if (group === "position") return POSITION_LABEL[k as BillPosition];
    if (group === "priority") return `${PRIORITY_LABEL[k as BillPriority]} priority`;
    return group === "stage" ? STATUS_LABEL[k as keyof typeof STATUS_LABEL] : k;
  };
  const groups = [...new Set(rows.map(keyOf))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return `/tracked${s ? `?${s}` : ""}`;
  };
  const exportQs = new URLSearchParams(Object.entries({ position: sp.position, priority: sp.priority })
    .filter((e): e is [string, string] => Boolean(e[1]))).toString();

  return (
    <>
      <PageHeader title="Tracked bills" meta={`${rows.length} ${rows.length === 1 ? "bill" : "bills"}`} actions={
        canExport && rows.length > 0 ? (
          <ActionLink plain href={`/api/export/tracked${exportQs ? `?${exportQs}` : ""}`} icon={Download}>Download CSV</ActionLink>
        ) : undefined
      }>
        <div className="flex flex-wrap justify-center gap-x-12 gap-y-3 pb-7">
          <Segmented center label="Group by" items={(Object.keys(GROUPS) as Group[]).map((g) => ({ key: g, label: GROUPS[g],
            href: href({ group: g === "position" ? undefined : g }) }))} current={group} />
          <Segmented center label="Show" items={[{ key: "all", label: "All", href: href({ position: undefined, mine: undefined }) },
            ...POSITIONS.map((p) => ({ key: p, label: POSITION_LABEL[p], href: href({ position: p, mine: undefined }) })),
            { key: "mine", label: "Assigned to me", href: href({ position: undefined, mine: "1" }) }]} current={sp.mine ? "mine" : (sp.position ?? "all")} />
        </div>
      </PageHeader>
      <div className="wrap">
        {rows.length === 0 ? (
          <EmptyState title={ sp.mine ? "No tracked bills are assigned to you." : sp.position
            ? `No tracked bills marked ${POSITION_LABEL[sp.position as BillPosition] ?? sp.position}.` : "The office is not tracking any bills yet." }
            action={<ActionLink href="/bills">Find bills to track</ActionLink>} />
        ) : (
          groups.map((g) => {
            const list = rows.filter((r) => keyOf(r) === g);
            return (
              <Section key={g} title={label(g)} titleClass={group === "position" ? POSITION_TONE[g as BillPosition] : undefined}
                meta={<span className="tabular">{list.length} {list.length === 1 ? "bill" : "bills"}</span>}>
                <BillList morph compact asideBelow={canEdit} closed={session?.closed} rows={list.map((r) => ({
                  id: r.id,
                  identifier: r.identifier,
                  title: r.title,
                  status: r.status,
                  result: r.statusText,
                  sub: (
                    <>
                      {[...new Set([r.primarySponsor, r.committee].filter(Boolean))].join(" · ")}
                      {r.reason && <span className="hand mt-1 block">{r.reason}</span>}
                      {(r.assignee || r.nextStep || r.dueDate) && (
                        <span className="hand mt-1 block">
                          {[r.nextStep, r.assignee ? `Handled by ${r.assignee}` : null].filter(Boolean).join(". ")}
                          {r.dueDate && <span className={r.dueDate < today ? "font-semibold text-danger" : "text-ink-2"}> Due {dateOnly(r.dueDate)}</span>}
                        </span>
                      )}
                    </>
                  ),
                  lastActionAt: r.lastActionAt,
                  lastActionText: r.lastActionText,
                  nextEvent: r.nextEvent,
                  position: r.position,
                  priority: r.priority,
                  aside: canEdit ? (
                    <span className="flex flex-col gap-2 md:items-end">
                      <PositionButtons billId={r.id} identifier={r.identifier} position={r.position} />
                      <TrackingExtras billId={r.id} identifier={r.identifier} priority={r.priority} />
                    </span>
                  ) : undefined,
                }))} />
              </Section>
            );
          })
        )}
      </div>
    </>
  );
}
