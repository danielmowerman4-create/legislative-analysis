"use client";

import { useId, useState } from "react";
import { Button, cn, Field, Input, Textarea } from "@/components/ui";
import {
  agencyActiveAction,
  aiLimitAction,
  issueActiveAction,
  saveAgencyAction,
  saveIssueAction,
  taggingLevelsAction,
} from "@/app/(center)/constituent-center/actions";
import { Err, TEXT_ACTION, useRun } from "./controls";

const lines = (text: string) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

type Issue = { key: string; parentKey: string | null; label: string; keywords: string[]; isActive: boolean };

function IssueForm({ issue, parentKey, nameLabel, onDone }: { issue?: Issue; parentKey?: string | null; nameLabel: string; onDone: () => void }) {
  const { pending, error, run } = useRun();
  const id = useId();
  const [label, setLabel] = useState(issue?.label ?? "");
  const [words, setWords] = useState((issue?.keywords ?? []).join("\n"));
  return (
    <form className="flex max-w-2xl flex-col gap-3 py-3" onSubmit={(e) => {
      e.preventDefault();
      run(() => saveIssueAction({ key: issue?.key, parentKey, label, keywords: lines(words) }), onDone);
    }}>
      <Field label={nameLabel} htmlFor={`${id}-name`}><Input id={`${id}-name`} required value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
      <Field label="Words that tag it" hint="One word or phrase on each line. Join two with + when both have to be in the same sentence, like school+funding."
        htmlFor={`${id}-words`}>
        <Textarea id={`${id}-words`} rows={Math.min(10, Math.max(4, lines(words).length + 1))} value={words} onChange={(e) => setWords(e.target.value)} />
      </Field>
      <div className="flex gap-3">
        <Button type="submit" variant="primary" disabled={pending || !label.trim()}>Save</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
      <Err text={error} />
    </form>
  );
}

function IssueRow({ issue, label }: { issue: Issue; label?: string }) {
  const { pending, error, run } = useRun();
  const [editing, setEditing] = useState(false);
  if (editing) return <li className="border-b border-line"><IssueForm issue={issue} nameLabel="Name" onDone={() => setEditing(false)} /></li>;
  return (
    <li className="border-b border-line py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className={cn("text-base font-semibold", issue.isActive ? "text-ink" : "text-ink-3")}>{label ?? issue.label}{!issue.isActive && ", off"}</p>
        <span className="flex gap-4">
          <button type="button" className={TEXT_ACTION} aria-label={`Edit ${issue.label}`} onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className={TEXT_ACTION} disabled={pending} aria-label={`Turn ${issue.isActive ? "off" : "on"} ${issue.label}`}
            onClick={() => run(() => issueActiveAction(issue.key, !issue.isActive))}>
            {issue.isActive ? "Turn off" : "Turn on"}
          </button>
        </span>
      </div>
      <p className="mt-0.5 text-sm text-ink-2">{issue.keywords.join(", ") || "No words yet, so it is only tagged by hand."}</p>
      <Err text={error} />
    </li>
  );
}

function Area({ area, issues }: { area: Issue; issues: Issue[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <details className="border-b border-line">
      <summary className={cn("flex cursor-pointer items-baseline justify-between gap-6 py-3", !area.isActive && "text-ink-3")}>
        <span className="display text-[24px]">{area.label}</span>
        <span className="tabular text-sm text-ink-2">{issues.length} {issues.length === 1 ? "issue" : "issues"}{!area.isActive && ", off"}</span>
      </summary>
      <ul className="pl-0 sm:pl-5">
        <IssueRow issue={area} label={`${area.label}, general`} />
        {issues.map((i) => (
          <IssueRow key={i.key} issue={i} />
        ))}
      </ul>
      <div className="py-3 sm:pl-5">
        {adding ? (
          <IssueForm parentKey={area.key} nameLabel="Name of the new issue" onDone={() => setAdding(false)} />
        ) : (
          <button type="button" className={TEXT_ACTION} onClick={() => setAdding(true)}>Add an issue to {area.label}</button>
        )}
      </div>
    </details>
  );
}

export function IssueList({ issues }: { issues: Issue[] }) {
  const [adding, setAdding] = useState(false);
  const areas = issues.filter((i) => !i.parentKey);
  return (
    <div>
      <div className="border-t border-line">
        {areas.map((a) => (
          <Area key={a.key} area={a} issues={issues.filter((i) => i.parentKey === a.key)} />
        ))}
      </div>
      <div className="mt-4">
        {adding ? (
          <IssueForm parentKey={null} nameLabel="Name of the new area" onDone={() => setAdding(false)} />
        ) : (
          <Button type="button" onClick={() => setAdding(true)}>Add an area</Button>
        )}
      </div>
    </div>
  );
}

type Agency = { id: string; name: string; abbreviation: string | null; domains: string[]; isActive: boolean };

function AgencyForm({ agency, onDone }: { agency?: Agency; onDone: () => void }) {
  const { pending, error, run } = useRun();
  const id = useId();
  const [name, setName] = useState(agency?.name ?? "");
  const [abbreviation, setAbbreviation] = useState(agency?.abbreviation ?? "");
  const [domains, setDomains] = useState((agency?.domains ?? []).join(", "));
  return (
    <form className="flex max-w-2xl flex-col gap-3 py-3" onSubmit={(e) => {
      e.preventDefault();
      run(() => saveAgencyAction({ id: agency?.id, name, abbreviation, domains: lines(domains) }), onDone);
    }}>
      <Field label="Agency name" htmlFor={`${id}-name`}><Input id={`${id}-name`} required value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Short name" htmlFor={`${id}-short`}>
        <Input id={`${id}-short`} value={abbreviation} onChange={(e) => setAbbreviation(e.target.value)} className="max-w-48" />
      </Field>
      <Field label="Its email domains" hint="Mail from these is filed under Government." htmlFor={`${id}-domains`}>
        <Input id={`${id}-domains`} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="dol.georgia.gov" />
      </Field>
      <div className="flex gap-3">
        <Button type="submit" variant="primary" disabled={pending || !name.trim()}>Save</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
      <Err text={error} />
    </form>
  );
}

function AgencyRow({ agency }: { agency: Agency }) {
  const { pending, error, run } = useRun();
  const [editing, setEditing] = useState(false);
  if (editing) return <li className="border-b border-line"><AgencyForm agency={agency} onDone={() => setEditing(false)} /></li>;
  return (
    <li className="border-b border-line py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className={cn("text-base font-semibold", agency.isActive ? "text-ink" : "text-ink-3")}>
          {agency.name}
          {agency.abbreviation ? ` (${agency.abbreviation})` : ""}
          {!agency.isActive && ", off"}
        </p>
        <span className="flex gap-4">
          <button type="button" className={TEXT_ACTION} aria-label={`Edit ${agency.name}`} onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className={TEXT_ACTION} disabled={pending} aria-label={`Turn ${agency.isActive ? "off" : "on"} ${agency.name}`}
            onClick={() => run(() => agencyActiveAction(agency.id, !agency.isActive))}>
            {agency.isActive ? "Turn off" : "Turn on"}
          </button>
        </span>
      </div>
      <p className="mt-0.5 text-sm text-ink-2">{agency.domains.join(", ") || "No email domains yet."}</p>
      <Err text={error} />
    </li>
  );
}

export function AgencyList({ agencies }: { agencies: Agency[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <div>
      {agencies.length > 0 && (
        <ul className="border-t border-line">
          {agencies.map((a) => (
            <AgencyRow key={a.id} agency={a} />
          ))}
        </ul>
      )}
      <div className="mt-4">
        {adding ? (
          <AgencyForm onDone={() => setAdding(false)} />
        ) : (
          <Button type="button" onClick={() => setAdding(true)}>Add an agency</Button>
        )}
      </div>
    </div>
  );
}

type Levels = { issue: number; position: number; billMatch: number; messageType: number };

const LEVELS: { key: keyof Levels; label: string }[] = [
  { key: "issue", label: "Issues" },
  { key: "billMatch", label: "Matching a bill" },
  { key: "position", label: "Support or oppose" },
  { key: "messageType", label: "Kind of mail" },
];

const percents = (levels: Levels) => Object.fromEntries(LEVELS.map((l) => [l.key, String(Math.round(levels[l.key] * 100))])) as Record<keyof Levels, string>;

export function TaggingLevels({ levels }: { levels: Levels }) {
  const { pending, error, run } = useRun();
  const id = useId();
  const [saved, setSaved] = useState(false);
  const [values, setValues] = useState(() => percents(levels));
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => {
      e.preventDefault();
      setSaved(false);
      const next = Object.fromEntries(LEVELS.map((l) => [l.key, Number(values[l.key]) / 100])) as Levels;
      run(() => taggingLevelsAction(next), () => setSaved(true));
    }}>
      <div className="grid max-w-3xl grid-cols-2 gap-4 sm:grid-cols-4">
        {LEVELS.map((l) => (
          <Field key={l.key} label={`${l.label}, percent`} htmlFor={`${id}-${l.key}`}>
            <Input id={`${id}-${l.key}`} type="number" min={50} max={99} required value={values[l.key]} onChange={(e) => {
              setSaved(false);
              setValues((v) => ({ ...v, [l.key]: e.target.value }));
            }} />
          </Field>
        ))}
      </div>
      <div className="flex items-baseline gap-4">
        <Button type="submit" disabled={pending}>Save levels</Button>
        {saved && <span className="hand" role="status">Saved</span>}
      </div>
      <Err text={error} />
    </form>
  );
}

export function AiLimit({ limit }: { limit: number }) {
  const { pending, error, run } = useRun();
  const [saved, setSaved] = useState(false);
  const id = useId();
  const [value, setValue] = useState(String(limit));
  return (
    <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => {
      e.preventDefault();
      setSaved(false);
      run(() => aiLimitAction(Number(value)), () => setSaved(true));
    }}>
      <Field label="AI readings a day" htmlFor={`${id}-limit`}>
        <Input
          id={`${id}-limit`}
          type="number"
          min={0}
          max={100000}
          required
          value={value}
          onChange={(e) => {
            setSaved(false);
            setValue(e.target.value);
          }}
          className="max-w-48"
        />
      </Field>
      <Button type="submit" disabled={pending}>Save</Button>
      {saved && <span className="hand pb-2" role="status">Saved</span>}
      <Err text={error} />
    </form>
  );
}
