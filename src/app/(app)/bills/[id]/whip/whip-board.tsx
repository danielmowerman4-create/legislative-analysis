"use client";

import { useMemo, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Chamber, SeatKey } from "@/components/chamber";
import { Tick } from "@/components/motion";
import { PenLine } from "@/components/marks";
import { cn, Select } from "@/components/ui";
import { votesNeeded, WHIP_LABEL, WHIP_STANCES, type WhipRule, type WhipStance } from "@/lib/whip";
import type { WhipRow } from "@/server/services/tools";
import { setWhipStanceAction } from "./actions";

const WORD: Record<WhipStance, string> = { yes: "text-support", lean_yes: "text-support", undecided: "text-ink-2", lean_no: "text-oppose", no: "text-oppose" };
const SORT_RANK: Record<WhipStance, number> = { undecided: 0, lean_yes: 1, lean_no: 2, yes: 3, no: 4 };
const COLUMN = "mx-auto max-w-[780px]";

const seatLine = (r: WhipRow) => `${r.name}, ${[(r.party ?? "").slice(0, 1).toUpperCase(), r.district].filter(Boolean).join("-")}: ${WHIP_LABEL[r.stance]}${r.basis ? `. ${r.basis}` : ""}`;

type WhipBoardProps = { billId: string; chamber: string; initial: WhipRow[]; seats: number; rule: WhipRule; canEdit: boolean; officeId?: string | null };

export function WhipBoard({ billId, chamber, initial, seats, rule, canEdit, officeId }: WhipBoardProps) {
  const [rows, setRows] = useState(initial);
  const [q, setQ] = useState("");
  const [party, setParty] = useState("");
  const [stance, setStance] = useState<WhipStance | "">("");
  const [sort, setSort] = useState("name");
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [, start] = useTransition();

  const counts = useMemo(() => Object.fromEntries(WHIP_STANCES.map((s) => [s, rows.filter((r) => r.stance === s).length])) as Record<WhipStance, number>,
    [rows]);
  const need = votesNeeded(seats, rule);
  const committed = counts.yes + counts.lean_yes;
  const gap = need - committed;
  const spare = <>Has the votes, <span className="marked">{-gap} to spare</span></>;
  const verdict = gap > 0 ? `${gap} ${gap === 1 ? "vote" : "votes"} short` : gap === 0 ? "Has exactly the votes" : spare;

  const save = (row: WhipRow, next: WhipStance | null, note?: string | null) => {
    const before = rows;
    setError(null);
    const changed = (r: WhipRow) => next ? { ...r, stance: next, officeSet: true, basis: "Set by your office",
      note: note === undefined ? r.note : note || null } : { ...r, stance: r.autoStance, basis: r.autoBasis, officeSet: false, note: null };
    setRows((all) => all.map((r) => (r.id !== row.id ? r : changed(r))));
    start(async () => {
      const result = await setWhipStanceAction(billId, row.id, next, note === undefined ? row.note : note);
      if (!result.ok) {
        setRows(before);
        setError(result.error);
      }
    });
  };

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = rows.filter((r) => (!term || r.name.toLowerCase().includes(term) || r.district === term) &&
      (!party || (r.party ?? "").toUpperCase().startsWith(party)) && (!stance || r.stance === stance));
    if (sort === "undecided") return [...list].sort((a, b) => SORT_RANK[a.stance] - SORT_RANK[b.stance] || a.name.localeCompare(b.name));
    if (sort === "party") return [...list].sort((a, b) => (a.party ?? "").localeCompare(b.party ?? "") || a.name.localeCompare(b.name));
    return list;
  }, [rows, q, party, stance, sort]);

  const filtering = Boolean(q.trim() || party || stance);
  const only = useMemo(() => (filtering ? new Set(shown.map((r) => r.id)) : null), [filtering, shown]);
  const seatRows = useMemo(() => rows.map((r) => ({ id: r.id, name: r.name, party: r.party, district: r.district, mark: r.stance })), [rows]);
  const pickedRow = rows.find((r) => r.id === picked);
  const hoverRow = rows.find((r) => r.id === hover);
  const listShown = listOpen || filtering;
  const rowProps = { canEdit, noteFor, setNoteFor, save };

  return (
    <>
      <section aria-label="Vote count">
        <div className="wrap pb-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-10 gap-y-1 pt-5">
            <p className="display text-[34px] text-ink lg:text-[40px]">{verdict}</p>
            <p className="tabular text-base text-ink-2">{committed} yes or leaning yes. {need} of {seats} seats needed.</p>
          </div>
          <Chamber
            className={cn(COLUMN, "mt-6")}
            seats={seatRows}
            playKey={`whip-${billId}-${chamber}`}
            value={committed}
            valueLabel={`${need} to pass`}
            officeId={officeId}
            selectedId={picked}
            only={only}
            onPick={(id) => setPicked((c) => (c === id ? null : id))}
            onHover={setHover}
            label={WHIP_STANCES.map((s) => `${WHIP_LABEL[s]} ${counts[s]}`).join(", ")}
          />
          <p className="tabular mx-auto mt-3 min-h-6 max-w-[780px] text-center text-sm text-ink">
            {hoverRow ? seatLine(hoverRow) : !pickedRow ? (
              <span className="text-ink-2">{canEdit ? "Choose a seat to make your office's call on that member." : "Choose a seat to see that member."}</span>
            ) : null}
          </p>
          <div role="group" aria-label="Show members by stance" className={cn(COLUMN, "mt-5 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-5")}>
            {WHIP_STANCES.map((s) => (
              <button key={s} type="button" aria-pressed={stance === s} onClick={() => setStance((c) => (c === s ? "" : s))}
                className="relative pb-2.5 text-left">
                <span className="block font-display text-xl font-bold text-ink"><Tick value={counts[s]} /></span>
                <span className="block text-sm font-semibold text-ink"><SeatKey mark={s}>{WHIP_LABEL[s]}</SeatKey></span>
                {stance === s && <PenLine seed={s} className="absolute bottom-0 left-0 w-full" />}
              </button>
            ))}
          </div>
          {pickedRow && (
            <div className={cn(COLUMN, "seat-panel mt-6 pt-2")}><MemberRow row={pickedRow} {...rowProps} /></div>
          )}
        </div>
      </section>

      <div className="wrap py-8 lg:py-10">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="relative flex min-w-48 flex-[1_1_100%] items-center sm:flex-[1_1_240px]">
            <span className="sr-only">Find a member</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Member name or district"
              className="h-10 w-full border-0 border-b border-line-strong bg-transparent pr-7 text-sm text-ink placeholder:text-ink-3 hover:border-ink focus:border-ink focus:shadow-[0_1px_0_0_var(--text)] focus:outline-none" />
            <Search aria-hidden className="pointer-events-none absolute right-0 size-4 text-ink-3" strokeWidth={1.75} />
          </label>
          <Select aria-label="Party" value={party} onChange={(e) => setParty(e.target.value)} className="flex-1 sm:w-36 sm:flex-none">
            <option value="">Any party</option>
            <option value="R">Republican</option>
            <option value="D">Democrat</option>
          </Select>
          <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} className="flex-1 sm:w-44 sm:flex-none">
            <option value="name">Sort: name</option>
            <option value="undecided">Sort: undecided first</option>
            <option value="party">Sort: party</option>
          </Select>
        </div>

        {error && (
          <p role="alert" className="mt-4 text-sm text-danger">{error}</p>
        )}

        <div className="mt-6 flex items-baseline justify-between gap-6 pb-2.5">
          <p className="kicker tabular text-ink">{shown.length} {shown.length === 1 ? "member" : "members"}</p>
          {!filtering && (
            <button type="button" aria-expanded={listOpen} onClick={() => setListOpen((o) => !o)}
              className="text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink-2">
              {listOpen ? "Hide the list" : "Show the list"}
            </button>
          )}
        </div>
        {listShown && (
          <ul className="divide-y divide-line border-b border-line">
            {shown.map((r) => (
              <li key={r.id} className="py-3"><MemberRow row={r} {...rowProps} /></li>
            ))}
            {shown.length === 0 && <li className="py-6 text-sm text-ink-3">No members match.</li>}
          </ul>
        )}
      </div>
    </>
  );
}

type MemberRowProps = { row: WhipRow; canEdit: boolean; noteFor: string | null; setNoteFor: (f: (c: string | null) => string | null) => void;
  save: (row: WhipRow, next: WhipStance | null, note?: string | null) => void };

function MemberRow({ row: r, canEdit, noteFor, setNoteFor, save }: MemberRowProps) {
  return (
    <div className="grid gap-x-8 gap-y-1.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,240px)_auto] lg:items-center">
      <div className="min-w-0">
        <span className="font-display text-base font-medium text-ink">{r.name}</span> <Party party={r.party} district={r.district} />
        {r.contact.email && (
          <a href={`mailto:${r.contact.email}`} className="ml-3 text-sm text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">Email</a>
        )}
        {r.contact.phone && (
          <a href={`tel:+1${r.contact.phone.replace(/\D/g, "")}`}
            className="ml-3 text-sm text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
            Call
          </a>
        )}
        {r.note && noteFor !== r.id && <p className="hand">{r.note}</p>}
      </div>
      <p className={cn("text-sm", r.officeSet ? "text-ink-2" : "text-ink-3")}>{r.basis ?? "No record yet"}</p>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        {canEdit ? (
          <>
            {WHIP_STANCES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={r.stance === s}
                aria-label={`${WHIP_LABEL[s]}: ${r.name}`}
                title={r.stance === s && r.officeSet ? "Clear your office's call" : undefined}
                onClick={() => (r.stance === s ? r.officeSet && save(r, null) : save(r, s))}
                className={cn("h-8 border-b-2 text-sm whitespace-nowrap transition-colors duration-150",
                  r.stance === s ? cn("border-current font-semibold", WORD[s]) : "border-transparent text-ink-3 hover:text-ink")}
              >
                {WHIP_LABEL[s]}
              </button>
            ))}
            <button type="button" aria-expanded={noteFor === r.id} onClick={() => setNoteFor((c) => (c === r.id ? null : r.id))}
              className="h-8 text-sm text-ink-3 underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink">
              Note
            </button>
          </>
        ) : (
          <span className={cn("text-sm font-semibold", WORD[r.stance])}>{WHIP_LABEL[r.stance]}</span>
        )}
      </div>
      {noteFor === r.id && (
        <input
          autoFocus
          defaultValue={r.note ?? ""}
          maxLength={300}
          aria-label={`Note on ${r.name}`}
          placeholder="What the office has heard from this member"
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setNoteFor(() => null);
          }}
          onBlur={(e) => {
            const value = e.currentTarget.value.trim();
            if (value !== (r.note ?? "")) save(r, r.stance, value);
            setNoteFor(() => null);
          }}
          className="h-10 w-full border-0 border-b border-line-strong bg-transparent text-sm text-ink placeholder:text-ink-3 focus:border-ink focus:shadow-[0_1px_0_0_var(--text)] focus:outline-none lg:col-span-3"
        />
      )}
    </div>
  );
}

function Party({ party, district }: { party: string | null; district: string | null }) {
  const p = (party ?? "").trim().toUpperCase().slice(0, 1);
  return (
    <span className="tabular text-sm whitespace-nowrap text-ink-3">
      {p && <span className={cn("font-semibold", p === "R" ? "text-party-r" : p === "D" ? "text-party-d" : "text-ink-2")}>{p}</span>}
      {p && district ? "-" : ""}
      {district}
    </span>
  );
}
