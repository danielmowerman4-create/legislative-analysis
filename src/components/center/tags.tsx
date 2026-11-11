"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { billLinkAction, billStanceAction, findBillsAction, issueTagAction } from "@/app/(center)/constituent-center/actions";
import { Err, TEXT_ACTION, useRun } from "./controls";
import { ROOT } from "./shell";

type IssueOption = { key: string; label: string; parentKey: string | null };
type IssueTagsProps = { messageId: string; tags: { key: string; label: string; needsReview: boolean }[]; options: IssueOption[]; canEdit: boolean };

const TAG_LINK = "font-semibold text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink";

export function IssueTags({ messageId, tags, options, canEdit }: IssueTagsProps) {
  const { pending, error, run } = useRun();
  const [choice, setChoice] = useState("");
  const used = new Set(tags.map((t) => t.key));
  const areas = options.filter((o) => !o.parentKey);
  return (
    <div className="flex flex-col gap-3">
      {tags.length === 0 && <p className="text-base text-ink-2">No issue yet.</p>}
      {tags.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-base">
          {tags.map((t) => (
            <li key={t.key} className="flex flex-wrap items-baseline gap-x-3">
              <Link href={`${ROOT}/mail?issue=${encodeURIComponent(t.key)}`} className={TAG_LINK}>{t.label}</Link>
              {canEdit && t.needsReview && (
                <button type="button" disabled={pending} className={TEXT_ACTION} onClick={() => run(() => issueTagAction(messageId, t.key, "confirm"))}>
                  Keep
                </button>
              )}
              {canEdit && (
                <button type="button" disabled={pending} className={TEXT_ACTION} aria-label={`Remove ${t.label}`}
                  onClick={() => run(() => issueTagAction(messageId, t.key, "reject"))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form className="flex items-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (choice) run(() => issueTagAction(messageId, choice, "confirm"), () => setChoice(""));
        }}>
          <Select aria-label="Add an issue" value={choice} onChange={(e) => setChoice(e.target.value)} className="min-w-0 flex-1">
            <option value="">Add an issue</option>
            {areas.map((a) => (
              <optgroup key={a.key} label={a.label}>
                {!used.has(a.key) && <option value={a.key}>{a.label}, general</option>}
                {options
                  .filter((o) => o.parentKey === a.key && !used.has(o.key))
                  .map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
              </optgroup>
            ))}
          </Select>
          <Button type="submit" disabled={pending || !choice}>Add</Button>
        </form>
      )}
      <Err text={error} />
    </div>
  );
}

type BillTag = {
  reference: string;
  billId: string | null;
  title: string | null;
  stance: string;
  position: "support" | "oppose" | "mixed" | "neutral" | "unclear";
  wrote: string | null;
  candidates: { id: string; identifier: string; title: string }[];
};

export function BillTags({ messageId, tags, canEdit }: { messageId: string; tags: BillTag[]; canEdit: boolean }) {
  const { pending, error, run } = useRun();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<BillTag["candidates"] | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {tags.length === 0 && <p className="text-base text-ink-2">No bill yet.</p>}
      {tags.length > 0 && (
        <ul className="flex flex-col gap-3 text-base">
          {tags.map((b) => (
            <li key={b.reference}>
              {b.billId ? (
                <Link href={`/bills/${b.billId}`} className={TAG_LINK}>{b.reference}</Link>
              ) : (
                <span className="font-semibold text-ink">{b.reference}</span>
              )}{" "}
              <span className="text-sm text-ink-2">{canEdit ? "" : b.stance}{b.wrote ? ` They wrote ${b.wrote}.` : ""}</span>
              {b.title && <span className="block text-sm text-ink-2">{b.title}</span>}
              {canEdit && (
                <Select aria-label={`Where they stand on ${b.reference}`} value={b.position} disabled={pending} className="mt-1.5 w-full"
                  onChange={(e) => run(() => billStanceAction(messageId, b.reference, e.target.value as BillTag["position"]))}>
                  <option value="support">Supports it</option>
                  <option value="oppose">Opposes it</option>
                  <option value="mixed">Mixed, or wants it changed</option>
                  <option value="neutral">Asks about it</option>
                  <option value="unclear">Does not say</option>
                </Select>
              )}
              {!b.billId && b.candidates.length > 0 && (
                <div className="mt-1.5">
                  <p className="text-sm text-ink-2">Did they mean</p>
                  <ul className="mt-1 flex flex-col gap-1.5">
                    {b.candidates.map((c) => (
                      <li key={c.id}>
                        {canEdit ? (
                          <button type="button" disabled={pending} className={`${TEXT_ACTION} text-left`}
                            onClick={() => run(() => billLinkAction(messageId, b.reference, c.id))}>
                            {c.identifier}: {c.title}
                          </button>
                        ) : (
                          <span className="text-sm text-ink">{c.identifier}: {c.title}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!b.billId && b.candidates.length === 0 && <span className="block text-sm text-ink-2">No matching bill this session.</span>}
              {canEdit && (
                <button type="button" disabled={pending} className={`${TEXT_ACTION} mt-1 block`} aria-label={`Remove ${b.reference}`}
                  onClick={() => run(() => billLinkAction(messageId, b.reference, null))}>
                  {b.billId ? "Remove" : "Not a bill"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form className="flex items-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) run(() => findBillsAction(query.trim()), (rows) => setFound(rows ?? []));
        }}>
          <Input aria-label="Find a bill to add" placeholder="Bill number or name" value={query} onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1" />
          <Button type="submit" disabled={pending || !query.trim()}>Find</Button>
        </form>
      )}
      {found?.length === 0 && <p className="text-sm text-ink-2">No bill matches that.</p>}
      {found && found.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {found.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                disabled={pending}
                className={`${TEXT_ACTION} text-left`}
                onClick={() =>
                  run(() => billLinkAction(messageId, f.identifier, f.id), () => {
                    setFound(null);
                    setQuery("");
                  })
                }
              >
                {f.identifier}: {f.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Err text={error} />
    </div>
  );
}
