import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { AppError } from "@/server/errors";
import { CASE_STATUSES, getCaseDetail } from "@/server/services/cases";
import { listTeam } from "@/server/services/offices";
import { BackLink, mailHref, ROOT } from "@/components/center/parts";
import { CaseControls, PersonNote } from "@/components/center/controls";
import { Status } from "@/components/ui";
import { fullDate, relative, sentence, shortDate } from "@/lib/format";

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireCenter();
  if (!can(ctx, "cases.read")) notFound();
  const { id } = await params;
  const d = await getCaseDetail(ctx, id).catch((e) => {
    if (e instanceof AppError && (e.code === "not_found" || e.code === "forbidden")) notFound();
    throw e;
  });
  const team = (await listTeam(ctx)).filter((t) => t.status === "active").map((t) => ({ userId: t.userId, name: t.name }));
  const c = d.case;
  const notes = d.events.filter((e) => e.type === "note");
  const history = d.events.filter((e) => e.type !== "note");
  return (
    <article className="pt-6">
      <BackLink href={`${ROOT}/casework`}>Casework</BackLink>
      <div className="mt-5 grid gap-x-14 gap-y-10 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <p className="anchor text-[52px] text-ink">{c.caseNumber}</p>
          <h1 className="display mt-2 max-w-[30ch] text-[34px] text-ink lg:text-[42px]">{c.title}</h1>
          <p className="mt-3 text-base text-ink-2">{c.category}{d.agency ? `, ${d.agency.name}` : ""}</p>
          {c.description && <div className="letter mt-6 max-w-[68ch]">{c.description}</div>}

          <section className="mt-10">
            <h2 className="rail-title text-[40px] text-ink">Notes</h2>
            <ul className="mt-3 flex flex-col gap-4">
              {notes.map((n) => (
                <li key={n.id}>
                  <p className="hand note-tilt">{n.body}</p>
                  <p className="text-sm text-ink-3">{n.actor ?? "Staff"}, {relative(n.createdAt)}</p>
                </li>
              ))}
            </ul>
            {can(ctx, "cases.write") && (
              <div className="mt-4 max-w-[68ch]"><PersonNote id={c.id} kind="case" /></div>
            )}
          </section>

          {d.messages.length > 0 && (
            <section className="mt-10">
              <h2 className="rail-title text-[40px] text-ink">Mail</h2>
              <ul className="mt-3">
                {d.messages.map((m) => (
                  <li key={m.id} className="flex justify-between gap-6 border-b border-line py-3 text-base">
                    <Link href={mailHref(m.id)} className="text-ink transition-colors hover:text-ink-2">{m.subject || "No subject"}</Link>
                    <span className="shrink-0 text-sm text-ink-3">{shortDate(m.sentAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <aside aria-label="Routing slip" className="flex min-w-0 flex-col gap-6">
          {can(ctx, "cases.write") ? (
            <CaseControls id={c.id} status={c.status} assignedTo={c.assignedTo} team={team} />
          ) : (
            <p className="text-base text-ink">{CASE_STATUSES[c.status]}</p>
          )}
          <div className="text-base">
            {c.priority === "urgent" && <Status tone="danger">Urgent</Status>}
            {d.contact && (
              <p>
                <Link href={`${ROOT}/people/${d.contact.id}`}
                  className="font-semibold text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink">
                  {d.contact.fullName ?? "Constituent"}
                </Link>
              </p>
            )}
            {c.isSensitive && <p className="text-sm font-semibold text-ink">Sensitive</p>}
            {c.consentStatus === "required" && (
              <Status tone="warn" className="whitespace-normal!">Written consent needed before contacting an agency</Status>
            )}
            {c.followUpAt && <p className="text-sm text-ink-2">Follow up {shortDate(c.followUpAt)}</p>}
          </div>
          <div>
            <h2 className="display text-[24px] text-ink">History</h2>
            <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink-2">
              {history.map((e) => (
                <li key={e.id} title={fullDate(e.createdAt)}>{sentence(e.type.replace(/_/g, " "))}, {e.actor ?? "Staff"}, {relative(e.createdAt)}</li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </article>
  );
}
