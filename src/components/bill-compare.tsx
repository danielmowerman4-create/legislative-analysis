import Link from "next/link";
import type { ReactNode } from "react";
import { BillAnchor, BillResult, PartyMark } from "@/components/bills";
import { cn } from "@/components/ui";
import { citationLabel, isSection } from "@/server/legislation/related";
import { isPassageVote, isVoiceVote } from "@/server/legislation/scoring";
import type { FiscalSide } from "@/server/legislation/connecticut-fiscal";
import type { getBillDetail } from "@/server/services/legislation";
import { dateOnly, shortDate } from "@/lib/format";

type Detail = Awaited<ReturnType<typeof getBillDetail>>;

// "To (1) do this, (2) do that" becomes a list.
function purposeItems(text: string) {
  const parts = text.split(/\s*\(\d+\)\s+/);
  if (parts.length < 3) return null;
  return parts.slice(1).map((p) => {
    const item = p.replace(/[,;]\s*(and)?\s*$/i, "").replace(/\.$/, "").trim();
    return item.charAt(0).toUpperCase() + item.slice(1);
  });
}

const codesOf = (d: Detail) => [...new Set(d.bill.codeSections.filter(isSection))];
const OPEN_TOPICS = 6;

function Whose({ d }: { d: Detail }) {
  return <p className="anchor mb-2 text-[30px] text-ink md:hidden">{d.bill.identifier}</p>;
}

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rise-on-view py-9 lg:py-11">
      <h2 className="rail-title text-[40px] text-ink lg:text-[52px]">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Sides({ a, b, render }: { a: Detail; b: Detail; render: (d: Detail) => ReactNode }) {
  return (
    <div className="grid gap-x-14 gap-y-9 md:grid-cols-2">
      {[a, b].map((d) => (
        <div key={d.bill.id} className="min-w-0"><Whose d={d} />{render(d)}</div>
      ))}
    </div>
  );
}

function Topics({ topics }: { topics: { sections: string; heading: string; text: string }[] }) {
  const item = (t: (typeof topics)[number], i: number) => (
    <li key={i}>
      <h4 className="display text-[22px] text-ink">{t.heading}</h4>
      {t.text && <p className="mt-0.5 text-base text-ink-2">{t.text}</p>}
      <p className="kicker mt-0.5 text-ink-3">Section {t.sections}</p>
    </li>
  );
  return (
    <div className="mt-6">
      <ol className="flex flex-col gap-4">{topics.slice(0, OPEN_TOPICS).map(item)}</ol>
      {topics.length > OPEN_TOPICS && (
        <details className="group mt-4">
          <summary className="cursor-pointer list-none text-base font-semibold text-ink underline decoration-line-strong underline-offset-4 group-open:mb-4">
            All {topics.length} parts of this bill
          </summary>
          <ol className="flex flex-col gap-4">{topics.slice(OPEN_TOPICS).map((t, i) => item(t, i + OPEN_TOPICS))}</ol>
        </details>
      )}
    </div>
  );
}

function ReadTheRest({ paragraphs }: { paragraphs: string[] }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-base font-semibold text-ink underline decoration-line-strong underline-offset-4 group-open:mb-3">
        Read the rest
      </summary>
      <div className="flex flex-col gap-3">{paragraphs.map((p, i) => <p key={i} className="max-w-[62ch] text-base text-ink-2">{p}</p>)}</div>
    </details>
  );
}

function WhatItDoes({ d }: { d: Detail }) {
  const analysis = d.bill.analysis;
  const purpose = d.bill.officialSummary;
  const items = !analysis?.summary.length && purpose ? purposeItems(purpose) : null;
  return (
    <>
      <Link href={`/bills/${d.bill.id}`} className="group block">
        <h3 className="text-xl font-semibold text-ink decoration-rule decoration-2 underline-offset-4 group-hover:underline">{d.bill.title}</h3>
      </Link>
      {analysis?.summary.length ? (
        <div className="mt-3 flex flex-col gap-3">
          {analysis.summary.slice(0, 2).map((p, i) => (
            <p key={i} className={cn("max-w-[62ch]", i === 0 ? "text-md leading-[29px] text-ink" : "text-base text-ink-2")}>{p}</p>
          ))}
          {analysis.summary.length > 2 && <ReadTheRest paragraphs={analysis.summary.slice(2)} />}
        </div>
      ) : items ? (
        <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 marker:text-rule">
          {items.map((t, i) => (
            <li key={i} className="max-w-[62ch] text-base text-ink">{t}</li>
          ))}
        </ul>
      ) : purpose ? (
        <p className="mt-3 max-w-[62ch] text-md leading-[29px] text-ink">{purpose}</p>
      ) : (
        <p className="mt-3 text-base text-ink-3">The legislature published no description of this bill.</p>
      )}
      {analysis && analysis.topics.length > 0 && <Topics topics={analysis.topics} />}
      <p className="mt-5 text-sm text-ink-2">
        {analysis ? (
          <>
            <a href={analysis.url} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
              Office of Legislative Research analysis
            </a>
            {analysis.describes ? ` of ${analysis.describes.replace(/^File/, "file")}` : ""}
          </>
        ) : purpose ? (
          "Statement of purpose, as introduced"
        ) : null}
      </p>
    </>
  );
}

function CostTable({ title, side }: { title: string; side: FiscalSide }) {
  if (!side.lines.length) {
    return side.said && !/below/i.test(side.said) ? (
      <dl>
        <Fact label={title}>{side.said}</Fact>
      </dl>
    ) : null;
  }
  return (
    <table className="w-full table-fixed text-left">
      <caption className="kicker text-left text-ink-3">{title}</caption>
      <thead>
        <tr>
          {side.years.map((y) => (
            <th key={y} scope="col" className="tabular pt-1 pb-2 text-sm font-normal text-ink-3">{y}</th>
          ))}
        </tr>
      </thead>
      {side.lines.map((l, i) => (
        <tbody key={i} className="border-t border-line">
          <tr>
            <th colSpan={side.years.length} scope="rowgroup" className="pt-2.5 text-base font-semibold text-ink">
              {l.who}
              <span className="block text-sm font-normal text-ink-2">{l.effect}</span>
            </th>
          </tr>
          <tr>
            {l.amounts.some((a) => !a) ? (
              <td colSpan={side.years.length} className="tabular pt-1 pb-3 text-base text-ink">{l.amounts.filter(Boolean).join(", ")}</td>
            ) : l.amounts.map((a, j) => <td key={j} className="tabular pt-1 pr-3 pb-3 align-top text-base text-ink">{a}</td>)}
          </tr>
        </tbody>
      ))}
    </table>
  );
}

function Costs({ d }: { d: Detail }) {
  const note = d.bill.fiscal;
  if (!note) return <p className="max-w-[62ch] text-base text-ink-3">The legislature published no fiscal note for this bill.</p>;
  const [first, ...rest] = note.explanation;
  // The budget's note says "None" above a page of figures; its words say it better.
  const noneOverFigures = note.state.said === "None" && note.municipal.said === "None" && note.explanation.join(" ").includes("$");
  return (
    <div className="flex flex-col gap-6">
      {!noneOverFigures && <CostTable title="State" side={note.state} />}
      {!noneOverFigures && <CostTable title="Municipalities" side={note.municipal} />}
      {first ? (
        <p className="max-w-[62ch] text-base text-ink">{first}</p>
      ) : (!note.state.lines.length && !note.municipal.lines.length &&
        <p className="max-w-[62ch] text-base text-ink">The figures are set out in the fiscal note.</p>)}
      {rest.length > 0 && <ReadTheRest paragraphs={rest} />}
      {note.later && (
        <dl>
          <Fact label="Later years"><span className="block max-w-[62ch]">{note.later}</span></Fact>
        </dl>
      )}
      <p className="text-sm text-ink-2">
        <a href={note.url} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
          Office of Fiscal Analysis fiscal note
        </a>
        {note.describes ? note.describes.startsWith("File") ? ` of ${note.describes.replace(/^File/, "file")}`
          : `, ${note.describes.charAt(0).toLowerCase()}${note.describes.slice(1)}` : ""}
      </p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="kicker text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-base text-ink">{children}</dd>
    </div>
  );
}

function Stands({ d }: { d: Detail }) {
  const last = d.actions[0];
  const passage = [...d.votes].filter((v) => v.chamber && isPassageVote(v.motion)).reverse();
  return (
    <dl className="flex flex-col gap-3">
      <Fact label="Result"><BillResult status={d.bill.status} statusText={d.bill.statusText} /></Fact>
      {last && <Fact label="Last action">{last.description} <span className="tabular whitespace-nowrap text-ink-3">{dateOnly(last.actionDate)}</span></Fact>}
      {d.bill.analysis?.effective && <Fact label="Takes effect">{d.bill.analysis.effective}</Fact>}
      {passage.length > 0 && (
        <Fact label="Floor votes">
          <ul>
            {passage.map((v) => (
              <li key={v.id}>
                {v.motion} <span className="tabular whitespace-nowrap">{isVoiceVote(v) ? "voice vote" : `${v.yes} to ${v.no}`}</span>
                {v.voteDate ? <span className="tabular whitespace-nowrap text-ink-3">, {shortDate(v.voteDate)}</span> : null}
              </li>
            ))}
          </ul>
        </Fact>
      )}
    </dl>
  );
}

function Behind({ d }: { d: Detail }) {
  const lead = d.sponsors.filter((s) => s.sponsorType === "primary");
  const members = d.sponsors.filter((s) => s.party);
  const dems = members.filter((s) => s.party!.toUpperCase().startsWith("D")).length;
  const reps = members.filter((s) => s.party!.toUpperCase().startsWith("R")).length;
  const others = members.length - dems - reps;
  return (
    <dl className="flex flex-col gap-3">
      {lead.length > 0 && (
        <Fact label="Introduced by">
          <ul>
            {lead.slice(0, 6).map((s) => (
              <li key={s.id}>{s.name} {s.party && <PartyMark party={s.party} district={s.district} />}</li>
            ))}
            {lead.length > 6 && <li className="text-ink-3">and {lead.length - 6} more</li>}
          </ul>
        </Fact>
      )}
      {members.length > 0 && (
        <Fact label="Members sponsoring">
          <span className="tabular">{members.length}: {dems} Democrats, {reps} Republicans{others > 0 ? `, ${others} other` : ""}</span>
        </Fact>
      )}
      {d.committees.length > 0 && <Fact label="Committees">{d.committees.map((c) => c.name.replace(/ Committee$/, "")).join(", ")}</Fact>}
    </dl>
  );
}

function Codes({ who, codes }: { who: string; codes: string[] }) {
  return (
    <div className="min-w-0">
      <h3 className="kicker text-ink-3">Only {who}: <span className="tabular">{codes.length}</span></h3>
      <p className="mt-1 text-base text-ink">
        {codes.length === 0 ? "None" : codes.slice(0, 18).map(citationLabel).join(", ")}
        {codes.length > 18 && <span className="text-ink-3"> and {codes.length - 18} more</span>}
      </p>
    </div>
  );
}

function Common({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <h3 className="kicker text-ink-3">{label}: <span className="tabular">{items.length}</span></h3>
      <p className="mt-1 max-w-[80ch] text-base text-ink">{items.join(", ")}</p>
    </div>
  );
}

export function BillCompare({ a, b, connection }: { a: Detail; b: Detail; connection: string[] }) {
  const codesA = codesOf(a);
  const codesB = codesOf(b);
  const both = codesA.filter((c) => codesB.includes(c));
  const subjects = a.bill.subjects.filter((s) => b.bill.subjects.includes(s));
  const sponsorKey = (s: Detail["sponsors"][number]) => s.legislatorId ?? s.name;
  const inB = new Set(b.sponsors.map(sponsorKey));
  const sharedSponsors = a.sponsors.filter((s) => inB.has(sponsorKey(s)));

  return (
    <div className="pt-4 pb-10">
      <div className="sticky top-[72px] z-10 hidden grid-cols-2 gap-x-14 bg-bg py-3 md:grid">
        {[a, b].map((d) => (
          <BillAnchor key={d.bill.id} identifier={d.bill.identifier} status={d.bill.status} billType={d.bill.billType} />
        ))}
      </div>

      <Row title="What it does"><Sides a={a} b={b} render={(d) => <WhatItDoes d={d} />} /></Row>

      <Row title="What it costs"><Sides a={a} b={b} render={(d) => <Costs d={d} />} /></Row>

      <Row title="Where they meet">
        <div className="flex flex-col gap-6">
          {connection.length > 0 && <p className="max-w-[70ch] text-md text-ink">{connection.join(". ")}.</p>}
          <div>
            <p className="display text-[28px] text-ink lg:text-[32px]">
              {both.length ? (
                <>
                  Both change <span className="marked">{both.length} {both.length === 1 ? "statute" : "statutes"}</span>
                </>
              ) : codesA.length && codesB.length ? "They change none of the same statutes" : "Not enough published to compare statutes"}
            </p>
            {both.length > 0 && <p className="mt-2 max-w-[80ch] text-base text-ink">{both.map(citationLabel).join(", ")}</p>}
          </div>
          {(codesA.length > 0 || codesB.length > 0) && (
            <div className="grid gap-x-14 gap-y-5 md:grid-cols-2">
              <Codes who={a.bill.identifier} codes={codesA.filter((c) => !both.includes(c))} />
              <Codes who={b.bill.identifier} codes={codesB.filter((c) => !both.includes(c))} />
            </div>
          )}
          {subjects.length > 0 && <Common label="Subjects in common" items={subjects} />}
          {sharedSponsors.length > 0 && <Common label="Sponsors of both" items={sharedSponsors.map((s) => s.name)} />}
        </div>
      </Row>

      <Row title="Where each stands"><Sides a={a} b={b} render={(d) => <Stands d={d} />} /></Row>

      <Row title="Who is behind it"><Sides a={a} b={b} render={(d) => <Behind d={d} />} /></Row>
    </div>
  );
}
