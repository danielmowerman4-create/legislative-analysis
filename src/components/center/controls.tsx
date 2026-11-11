"use client";

import { useRouter } from "next/navigation";
import { addTransitionType, createContext, use, useId, useState, useTransition, type ReactNode } from "react";
import { Button, Field, Input, LinkButton, Select, Textarea } from "@/components/ui";
import { PenCheck } from "@/components/marks";
import type { ActionResult } from "@/app/(app)/_lib/action";
import type { DistrictStatus } from "@/server/db/schema";
import { composeLink, OPENS_IN_LABEL, type OpensIn } from "@/lib/compose";
import { appPasswordProblem, type AppPasswordShape } from "@/lib/app-password";
import {
  addRuleAction,
  addressLookupAction,
  aiGuidanceAction,
  aiProcessingAction,
  approveReplyAction,
  askStatusAction,
  assignAction,
  bulkAssignAction,
  bulkTriageAction,
  caseFromAskAction,
  caseNoteAction,
  checkMailAction,
  configureMailboxAction,
  confirmSenderAction,
  connectApplicationAction,
  connectOAuthAction,
  contactAddressAction,
  contactDistrictAction,
  contactNoteAction,
  connectPasswordAction,
  describeMailboxAction,
  disconnectMailboxAction,
  discardReplyAction,
  draftReplyAction,
  formLetterSettingsAction,
  internalDomainsAction,
  messageNoteAction,
  rejectSenderAction,
  restoreAction,
  ruleStatusAction,
  saveReplyAction,
  sendingOffAction,
  sendingOnAction,
  sendReplyAction,
  sentReplyAction,
  signatureAction,
  triageAction,
  updateCaseAction,
} from "@/app/(center)/constituent-center/actions";

type Person = { userId: string; name: string };

export function useRun(type?: string) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<ActionResult<T>>, after?: (data: T | undefined) => void) =>
    start(async () => {
      if (type) addTransitionType(type);
      setError(null);
      const r = await fn();
      if (r.ok) after?.(r.data);
      else setError(r.error);
    });
  return { pending, error, run };
}

export function Err({ text }: { text: string | null }) {
  return text ? (
    <p className="text-sm text-danger" role="alert">{text}</p>
  ) : null;
}

export const TEXT_ACTION = "text-sm font-semibold text-ink underline underline-offset-4 decoration-line-strong transition-colors hover:decoration-ink disabled:opacity-50";

function Ticked({ children }: { children: ReactNode }) {
  return <p className="hand flex items-center gap-2" role="status"><PenCheck className="size-5 shrink-0" />{children}</p>;
}

type Choice = { label: string; ticked: string; act: () => Promise<ActionResult<unknown>> };

function TickChoices({ choices, className }: { choices: Choice[]; className?: string }) {
  const { pending, error, run } = useRun("list");
  const [ticked, setTicked] = useState<string | null>(null);
  return (
    <div className={className}>
      {ticked && !error ? (
        <Ticked>{ticked}</Ticked>
      ) : (
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {choices.map((c) => (
            <button key={c.label} type="button" disabled={pending} className={TEXT_ACTION} onClick={() => {
              setTicked(c.ticked);
              run(c.act);
            }}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      <Err text={error} />
    </div>
  );
}

export function AskButtons({ id, className }: { id: string; className?: string }) {
  return (
    <TickChoices className={className} choices={[
      { label: "Handled", ticked: "Handled", act: () => askStatusAction(id, "handled") },
      { label: "Not needed", ticked: "Not needed", act: () => askStatusAction(id, "dismissed") },
    ]} />
  );
}

export function SenderButtons({ messageId, className }: { messageId: string; className?: string }) {
  return (
    <TickChoices className={className} choices={[
      { label: "I know this sender", ticked: "Sender known", act: () => confirmSenderAction(messageId) },
      { label: "Not genuine", ticked: "Not genuine", act: () => rejectSenderAction(messageId) },
    ]} />
  );
}

function TextActionButton({ act, children }: { act: () => Promise<ActionResult<unknown>>; children: ReactNode }) {
  const { pending, error, run } = useRun();
  return (
    <>
      <button type="button" disabled={pending} className={TEXT_ACTION} onClick={() => run(act)}>{children}</button>
      <Err text={error} />
    </>
  );
}

function TeamOptions({ team }: { team: Person[] }) {
  return team.map((t) => (
    <option key={t.userId} value={t.userId}>{t.name}</option>
  ));
}

function CheckLine({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex items-start gap-3 text-base text-ink">
      <input type="checkbox" className="mt-1.5 size-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function RestoreButton({ ledgerId }: { ledgerId: string }) {
  return <TextActionButton act={() => restoreAction(ledgerId)}>Bring back</TextActionButton>;
}

export function Handling({ messageId, assignedTo, status, team }: { messageId: string; assignedTo: string | null; status: string; team: Person[] }) {
  const { pending, error, run } = useRun();
  return (
    <div className="flex flex-col gap-3">
      <Field label="Handled by" htmlFor="m-assign">
        <Select id="m-assign" disabled={pending} defaultValue={assignedTo ?? ""} onChange={(e) => run(() => assignAction(messageId, e.target.value || null))}>
          <option value="">Nobody yet</option>
          <TeamOptions team={team} />
        </Select>
      </Field>
      {status === "done" ? (
        <Button type="button" disabled={pending} onClick={() => run(() => triageAction(messageId, "in_progress"))}>Reopen</Button>
      ) : (
        <Button type="button" variant="primary" disabled={pending} onClick={() => run(() => triageAction(messageId, "done"))}>Mark done</Button>
      )}
      <Err text={error} />
    </div>
  );
}

function NoteBox({ rows, save }: { rows: number; save: (body: string) => Promise<ActionResult<unknown>> }) {
  const { pending, error, run } = useRun();
  const [body, setBody] = useState("");
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => {
      e.preventDefault();
      run(() => save(body), () => setBody(""));
    }}>
      <Textarea aria-label="Add a note" rows={rows} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note" />
      <Button type="submit" disabled={pending || !body.trim()} className="self-start">Save note</Button>
      <Err text={error} />
    </form>
  );
}

export function NoteForm({ messageId }: { messageId: string }) {
  return <NoteBox rows={2} save={(body) => messageNoteAction(messageId, body)} />;
}

export function PersonNote({ id, kind }: { id: string; kind: "case" | "contact" }) {
  const save = kind === "case" ? caseNoteAction : contactNoteAction;
  return <NoteBox rows={3} save={(body) => save(id, body, "office")} />;
}

type OpenCaseProps = { askId: string; defaultTitle: string; defaultCategory: string; team: Person[]; agencies: { id: string; name: string }[] };

export function OpenCase({ askId, defaultTitle, defaultCategory, team, agencies }: OpenCaseProps) {
  const router = useRouter();
  const { pending, error, run } = useRun();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [category, setCategory] = useState(defaultCategory);
  const [assignedTo, setAssignedTo] = useState("");
  const [agencyId, setAgencyId] = useState("");
  if (!open) return <button type="button" className={TEXT_ACTION} onClick={() => setOpen(true)}>Open a case</button>;
  return (
    <form className="mt-2 flex flex-col gap-3" onSubmit={(e) => {
      e.preventDefault();
      const fields = { title, category, assignedTo: assignedTo || null, agencyId: agencyId || null };
      run(() => caseFromAskAction(askId, fields), (id) => router.push(`/constituent-center/casework/${id}`));
    }}>
      <Field label="Case title"><Input value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
      <Field label="Kind of help"><Input value={category} onChange={(e) => setCategory(e.target.value)} required /></Field>
      <Field label="Agency">
        <Select value={agencyId} onChange={(e) => setAgencyId(e.target.value)}>
          <option value="">Not sure yet</option>
          {agencies.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Handled by">
        <Select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}><option value="">Nobody yet</option><TeamOptions team={team} /></Select>
      </Field>
      <div className="flex gap-3">
        <Button type="submit" variant="primary" disabled={pending}>Open case</Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <Err text={error} />
    </form>
  );
}

export function DraftReplyButton({ messageId }: { messageId: string }) {
  const { pending, error, run } = useRun();
  return (
    <div>
      <Button type="button" disabled={pending} onClick={() => run(() => draftReplyAction(messageId))}>Draft a reply</Button>
      <Err text={error} />
    </div>
  );
}

type ReplyRoute = { from: string | null; opensIn: OpensIn; canSend: boolean; problems: string[] };

type Draft = { id: string; subject: string; bodyText: string; status: string; toAddresses: string[] };

export function ReplyEditor({ draft, canApprove, route }: { draft: Draft; canApprove: boolean; route?: ReplyRoute }) {
  const { pending, error, run } = useRun();
  const [body, setBody] = useState(draft.bodyText);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const dirty = body !== draft.bodyText;
  const needsWords = body.includes("[Office response]");
  const approved = draft.status === "approved" && !dirty;
  const people = draft.toAddresses.length;
  const to = `To ${people > 3 ? `${people} people` : draft.toAddresses.join(", ")}`;
  const link = composeLink(route?.opensIn ?? "mail", draft.toAddresses, draft.subject, body);
  const copy = async () => {
    await navigator.clipboard.writeText(body);
    setCopied(true);
  };
  if (draft.status === "sending") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-2">{to}</p>
        <div className="letter text-ink">{draft.bodyText}</div>
        <p className="text-base font-semibold text-ink" role="status">Going out now{route?.from ? ` from ${route.from}` : ""}.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-2">{to}</p>
      <Textarea aria-label="Reply" rows={14} value={body} onChange={(e) => setBody(e.target.value)} className="text-base" />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={pending || !dirty} onClick={() => run(() => saveReplyAction(draft.id, body))}>Save</Button>
        {canApprove && draft.status === "draft" && (
          <Button type="button" variant="primary" disabled={pending || dirty || needsWords} onClick={() => run(() => approveReplyAction(draft.id))}>
            Approve
          </Button>
        )}
        {approved && route?.canSend && !confirming && (
          <Button type="button" variant="primary" disabled={pending} onClick={() => setConfirming(true)}>Send from {route.from}</Button>
        )}
        {approved && route?.canSend && confirming && (
          <>
            <Button type="button" variant="primary" disabled={pending} onClick={() => run(() => sendReplyAction(draft.id), () => setConfirming(false))}>
              {pending ? "Sending" : people > 1 ? `Send to ${people} people now` : `Send to ${draft.toAddresses[0]} now`}
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>Not yet</Button>
          </>
        )}
        {approved && !route?.canSend && (
          <LinkButton href={link.href} variant="primary" target="_blank" rel="noreferrer" prefetch={false} onClick={link.carriesText ? undefined : copy}>
            {OPENS_IN_LABEL[route?.opensIn ?? "mail"]}
          </LinkButton>
        )}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        {approved && (
          <button type="button" className={TEXT_ACTION} onClick={copy}>{copied ? "Copied" : "Copy the reply"}</button>
        )}
        {approved && route?.canSend && (
          <a href={link.href} target="_blank" rel="noreferrer" onClick={link.carriesText ? undefined : copy} className={TEXT_ACTION}>
            {OPENS_IN_LABEL[route.opensIn]}
          </a>
        )}
        {draft.status === "approved" && (
          <button type="button" disabled={pending} className={TEXT_ACTION} onClick={() => run(() => sentReplyAction(draft.id))}>I sent it</button>
        )}
        <button type="button" disabled={pending} className={TEXT_ACTION} onClick={() => run(() => discardReplyAction(draft.id))}>Discard</button>
      </div>
      {needsWords && <p className="text-sm text-ink-2">Replace [Office response] before approving.</p>}
      {approved && !link.carriesText && <p className="text-sm text-ink-2">This reply is long, so opening it copies the text for you to paste.</p>}
      {route?.problems.map((p) => (
        <p key={p} className="text-sm text-danger">{p}</p>
      ))}
      <Err text={error} />
    </div>
  );
}

const CASE_LABELS: Record<string, string> = { new: "New", under_review: "Under review", awaiting_constituent: "Waiting on constituent",
  awaiting_agency: "Waiting on agency", resolved: "Resolved", closed: "Closed" };

export function CaseControls({ id, status, assignedTo, team }: { id: string; status: string; assignedTo: string | null; team: Person[] }) {
  const { pending, error, run } = useRun();
  return (
    <div className="flex flex-col gap-3">
      <Field label="Status">
        <Select disabled={pending} defaultValue={status} onChange={(e) => run(() => updateCaseAction(id, { status: e.target.value as never }))}>
          {Object.entries(CASE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </Select>
      </Field>
      <Field label="Handled by">
        <Select disabled={pending} defaultValue={assignedTo ?? ""} onChange={(e) => run(() => updateCaseAction(id, { assignedTo: e.target.value || null }))}>
          <option value="">Nobody yet</option>
          <TeamOptions team={team} />
        </Select>
      </Field>
      <Err text={error} />
    </div>
  );
}

export function RuleForm() {
  const { pending, error, run } = useRun();
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<"hide" | "relay">("hide");
  return (
    <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => {
      e.preventDefault();
      run(() => addRuleAction(kind, value, ""), () => setValue(""));
    }}>
      <Field label="Address or domain">
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="news@example.org" className="min-w-64" required />
      </Field>
      <Field label="What to do">
        <Select value={kind} onChange={(e) => setKind(e.target.value as "hide" | "relay")} className="min-w-64">
          <option value="hide">Set this mail aside</option>
          <option value="relay">It sends for people</option>
        </Select>
      </Field>
      <Button type="submit" disabled={pending || !value.trim()}>Add rule</Button>
      <Err text={error} />
    </form>
  );
}

export function RuleButton({ id, status }: { id: string; status: string }) {
  return (
    <TextActionButton act={() => ruleStatusAction(id, status === "active" ? "retired" : "active")}>
      {status === "active" ? "Turn off" : status === "proposed" ? "Confirm" : "Turn on"}
    </TextActionButton>
  );
}

function SwitchButton({ act, children }: { act: () => Promise<ActionResult<unknown>>; children: ReactNode }) {
  const { pending, error, run } = useRun();
  return (
    <div className="flex flex-col gap-2">
      <Button type="button" className="self-start" disabled={pending} onClick={() => run(act)}>{children}</Button>
      <Err text={error} />
    </div>
  );
}

export function AiSwitch({ enabled }: { enabled: boolean }) {
  return <SwitchButton act={() => aiProcessingAction(!enabled)}>{enabled ? "Turn AI reading off" : "Turn AI reading on"}</SwitchButton>;
}

export function DomainsForm({ domains }: { domains: string[] }) {
  const { pending, error, run } = useRun();
  const [text, setText] = useState(domains.join(", "));
  return (
    <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => {
      e.preventDefault();
      run(() => internalDomainsAction(text));
    }}>
      <Field label="The office's own email domains">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="house.ga.gov" className="min-w-80" />
      </Field>
      <Button type="submit" disabled={pending}>Save domains</Button>
      <Err text={error} />
    </form>
  );
}

const GOOGLE_STEPS = "Google will warn that it has not verified this app. Press Advanced, then the Go to link, then tick the box that lets it read your email.";
const STATEMENT = "I am authorized to connect this mailbox. Connecting lets this app read it and nothing else, and turns on two-step sign-in for this office.";
const SEND_STATEMENT = "I am authorized to let this app send replies from this mailbox. It sends a reply only after a person approves it and presses Send.";

type MailboxAnswer = { label: string; signIn: "google" | "microsoft" | null; password: boolean; appPasswordUrl: string | null;
  appPassword: AppPasswordShape | null; twoStepUrl: string | null; outlook: boolean };
const INLINE_LINK = "font-semibold underline underline-offset-4 decoration-line-strong hover:decoration-ink";

const go = (url: string | null | undefined) => {
  if (url) window.location.assign(url);
};

type AppPasswordFormProps = { label: string; appPasswordUrl: string | null; twoStepUrl: string | null; shape: AppPasswordShape | null; email: string;
  askAddress: boolean; ack: boolean };

function AppPasswordForm({ label, appPasswordUrl, twoStepUrl, shape, email, askAddress, ack }: AppPasswordFormProps) {
  const { pending, error, run } = useRun();
  const id = useId();
  const [address, setAddress] = useState(email);
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const looks = shape === "letters16" ? "16-letter " : "";
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => {
      e.preventDefault();
      const wrongKind = appPasswordProblem(label, shape, password);
      setProblem(wrongKind);
      if (!wrongKind) run(() => connectPasswordAction({ email: address, password, acknowledged: ack }), go);
    }}>
      <p className="max-w-2xl text-base text-ink">
        {label} makes a separate {looks}password for this app. It is not your regular {label} password.{" "}
        {twoStepUrl && (
          <>
            <a href={twoStepUrl} target="_blank" rel="noreferrer" className={INLINE_LINK}>Turn on 2-Step Verification</a>{" "}
            if it is off, then{" "}
          </>
        )}
        {appPasswordUrl ? (
          <>
            <a href={appPasswordUrl} target="_blank" rel="noreferrer" className={INLINE_LINK}>
              {twoStepUrl ? "make an app password here" : "Make one here"}
            </a>{" "}
            and paste it below.
          </>
        ) : (
          "Make one in your email account's security settings and paste it below."
        )}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        {askAddress && (
          <Field label={`${label} address`} htmlFor={`${id}-address`}>
            <Input id={`${id}-address`} type="email" autoComplete="off" required value={address} onChange={(e) => setAddress(e.target.value)}
              className="min-w-72" />
          </Field>
        )}
        <Field label="App password" htmlFor={`${id}-code`}>
          {/* Plain text and closed to password managers, so a real password is never filled in. */}
          <Input
            id={`${id}-code`}
            name="app-code"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setProblem(null);
            }}
            placeholder={shape === "letters16" ? "abcd efgh ijkl mnop" : undefined}
            className="min-w-72 tabular"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={pending || !address || !password}>Connect</Button>
      </div>
      <Err text={problem ?? error} />
    </form>
  );
}

export function ConnectMailbox({ microsoft, google, approvalUrl }: { microsoft: boolean; google: boolean; approvalUrl: string | null }) {
  const { pending, error, run } = useRun();
  const id = useId();
  const [ack, setAck] = useState(false);
  const [way, setWay] = useState<"google" | "gmail" | "other" | null>(null);
  const [email, setEmail] = useState("");
  const [answer, setAnswer] = useState<MailboxAnswer | null>(null);
  const [usePassword, setUsePassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tenantId, setTenantId] = useState("");
  const [mailbox, setMailbox] = useState("");
  const signIn = (provider: "google" | "microsoft") => run(() => connectOAuthAction(provider, ack), go);
  return (
    <div className="flex flex-col gap-5">
      <CheckLine checked={ack} onChange={setAck}>{STATEMENT}</CheckLine>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="primary" disabled={pending || !microsoft} onClick={() => signIn("microsoft")}>Connect Outlook</Button>
        <Button type="button" variant="primary" disabled={pending} onClick={() => setWay(google ? "google" : "gmail")}>Connect Gmail</Button>
        <Button type="button" disabled={pending} onClick={() => setWay("other")}>Another email</Button>
      </div>
      {!microsoft && <p className="text-base text-ink">Outlook sign-in is not set up on this server yet.</p>}
      <Err text={error} />

      {way === "google" && (
        <div className="flex flex-col gap-3">
          <p className="max-w-2xl text-base text-ink">{GOOGLE_STEPS}</p>
          <div>
            <Button type="button" variant="primary" disabled={pending} onClick={() => signIn("google")}>Continue to Google</Button>
          </div>
        </div>
      )}

      {way === "gmail" && (
        <AppPasswordForm label="Gmail" appPasswordUrl="https://myaccount.google.com/apppasswords" twoStepUrl="https://myaccount.google.com/signinoptions/twosv"
          shape="letters16" email="" askAddress ack={ack} />
      )}

      {way === "other" && (
        <>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => {
            e.preventDefault();
            setUsePassword(false);
            run(() => describeMailboxAction(email), (a) => setAnswer(a ?? null));
          }}>
            <Field label="Email address" htmlFor={`${id}-email`}>
              <Input
                id={`${id}-email`}
                type="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setAnswer(null);
                }}
                className="min-w-72"
              />
            </Field>
            <Button type="submit" disabled={pending || !email}>Continue</Button>
          </form>
          {answer?.signIn && !usePassword && (
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
              <p className="text-base text-ink">That mailbox is on {answer.label}.</p>
              <Button type="button" variant="primary" disabled={pending} onClick={() => signIn(answer.signIn!)}>Connect {answer.label}</Button>
              {answer.password && <button type="button" className={TEXT_ACTION} onClick={() => setUsePassword(true)}>Use an app password instead</button>}
              {answer.signIn === "google" && <p className="basis-full max-w-2xl text-base text-ink">{GOOGLE_STEPS}</p>}
            </div>
          )}
          {answer && (usePassword || !answer.signIn) && answer.password && (
            <AppPasswordForm key={email} label={answer.label} appPasswordUrl={answer.appPasswordUrl} twoStepUrl={answer.twoStepUrl} shape={answer.appPassword}
              email={email} askAddress={false} ack={ack} />
          )}
          {answer && !answer.signIn && !answer.password && (
            <p className="max-w-2xl text-base text-ink">That mailbox is on Outlook, and Outlook sign-in is not set up on this server yet.</p>
          )}
        </>
      )}

      <details className="border-t border-line pt-4">
        <summary className="cursor-pointer text-sm font-semibold text-ink">Work or government Outlook that needs IT approval</summary>
        <div className="mt-3 flex max-w-2xl flex-col gap-3">
          {approvalUrl && (
            <>
              <p className="text-base text-ink">Your IT administrator approves this app once for the organization, to read mail and nothing else. Send them this link. After that, each person presses Connect Outlook.</p>
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <span className="min-w-0 break-all text-sm text-ink-2">{approvalUrl}</span>
                <button type="button" className={TEXT_ACTION} onClick={async () => {
                  await navigator.clipboard.writeText(approvalUrl);
                  setCopied(true);
                }}>
                  {copied ? "Copied" : "Copy the link"}
                </button>
              </div>
            </>
          )}
          <p className="text-base text-ink">If IT gave this app access to one mailbox instead, enter it here.</p>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => {
            e.preventDefault();
            run(() => connectApplicationAction({ tenantId, mailbox, acknowledged: ack }), go);
          }}>
            <Field label="Microsoft tenant ID" htmlFor={`${id}-tenant`}>
              <Input id={`${id}-tenant`} value={tenantId} onChange={(e) => setTenantId(e.target.value)} className="min-w-72" />
            </Field>
            <Field label="Mailbox your admin granted" htmlFor={`${id}-mailbox`}>
              <Input id={`${id}-mailbox`} value={mailbox} onChange={(e) => setMailbox(e.target.value)} className="min-w-64" />
            </Field>
            <Button type="submit" disabled={pending || !microsoft || !tenantId || !mailbox}>Connect</Button>
          </form>
        </div>
      </details>
    </div>
  );
}

type Folder = { id: string; name: string; isInbox: boolean; isSent: boolean };

type FolderFormProps = { id: string; folders: Folder[]; defaultFrom: string; current?: { folderIds: string[]; watchSent: boolean } };

export function FolderForm({ id, folders, defaultFrom, current }: FolderFormProps) {
  const router = useRouter();
  const { pending, error, run } = useRun();
  const inbox = folders.find((f) => f.isInbox);
  const sent = folders.find((f) => f.isSent);
  const onlyInbox = !current || (current.folderIds.length === 1 && current.folderIds[0] === inbox?.id);
  const [scope, setScope] = useState<"inbox" | "folders">(inbox && onlyInbox ? "inbox" : "folders");
  const [picked, setPicked] = useState<string[]>(onlyInbox ? [] : (current?.folderIds ?? []));
  const [watchSent, setWatchSent] = useState(current ? current.watchSent : true);
  const chosen = scope === "inbox" && inbox ? [inbox] : folders.filter((f) => picked.includes(f.id));
  // Sent is watched only for replies, unless it is picked as a folder to read.
  const canWatch = Boolean(sent) && !chosen.some((f) => f.id === sent!.id);
  const [from, setFrom] = useState(defaultFrom);
  const toggle = (f: string) => setPicked((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => {
      e.preventDefault();
      const folders = chosen.map((f) => ({ id: f.id, name: f.name }));
      const sentFolder = canWatch && watchSent ? { id: sent!.id, name: sent!.name } : null;
      run(() => configureMailboxAction(id, { folders, importFrom: from, sentFolder }), () => router.replace("/constituent-center/setup"));
    }}>
      {inbox && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-sm font-semibold text-ink">Which mail should this read?</legend>
          <label className="flex items-center gap-3 text-base text-ink">
            <input type="radio" name="mail-scope" className="size-4" checked={scope === "inbox"} onChange={() => setScope("inbox")} />
            The general inbox
          </label>
          <label className="flex items-center gap-3 text-base text-ink">
            <input type="radio" name="mail-scope" className="size-4" checked={scope === "folders"} onChange={() => setScope("folders")} />
            Only the folders I choose
          </label>
        </fieldset>
      )}
      {scope === "folders" && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-sm font-semibold text-ink">Only read these folders</legend>
          {folders.map((f) => (
            <label key={f.id} className="flex items-center gap-3 text-base text-ink">
              <input type="checkbox" className="size-4" checked={picked.includes(f.id)} onChange={() => toggle(f.id)} />
              {f.name}
            </label>
          ))}
        </fieldset>
      )}
      {canWatch && (
        <CheckLine checked={watchSent} onChange={setWatchSent}>
          Mark a letter answered when a reply to it appears in {sent!.name}. Nothing else in {sent!.name} is read.
        </CheckLine>
      )}
      <Field label="Start reading from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="max-w-56" required /></Field>
      <Button type="submit" variant="primary" className="self-start" disabled={pending || !chosen.length}>{current ? "Save" : "Start reading"}</Button>
      <Err text={error} />
    </form>
  );
}

export function MailboxSending({ id, address, on, needsSignIn }: { id: string; address: string; on: boolean; needsSignIn: boolean }) {
  const { pending, error, run } = useRun();
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  if (on) {
    return (
      <>
        <button type="button" disabled={pending} className={TEXT_ACTION} onClick={() => run(() => sendingOffAction(id))}>Turn sending off</button>
        <Err text={error} />
      </>
    );
  }
  if (!open) return <button type="button" className={TEXT_ACTION} onClick={() => setOpen(true)}>Let this app send replies</button>;
  return (
    <div className="mt-3 flex w-full max-w-2xl flex-col gap-3">
      <CheckLine checked={ack} onChange={setAck}>{SEND_STATEMENT}</CheckLine>
      <p className="text-base text-ink">
        {needsSignIn ? "You sign in to the mailbox once more to allow it. " : ""}A test message goes from {address} to itself first.
      </p>
      <div className="flex gap-3">
        <Button type="button" variant="primary" disabled={pending || !ack}
          onClick={() => run(() => sendingOnAction(id, ack), (url) => (url ? go(url) : setOpen(false)))}>
          Turn sending on
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <Err text={error} />
    </div>
  );
}

export function CheckMailButton() {
  const { pending, error, run } = useRun();
  const [asked, setAsked] = useState(false);
  return (
    <>
      <button type="button" disabled={pending || asked} className={TEXT_ACTION} onClick={() => run(() => checkMailAction(), () => setAsked(true))}>
        {asked ? "Checking now" : "Check for new mail"}
      </button>
      <Err text={error} />
    </>
  );
}

export function SignatureForm({ signature }: { signature: string }) {
  const { pending, error, run } = useRun();
  const [text, setText] = useState(signature);
  return (
    <form className="flex max-w-xl flex-col gap-3" onSubmit={(e) => {
      e.preventDefault();
      run(() => signatureAction(text));
    }}>
      <Textarea aria-label="How the office signs its replies" rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={"Sincerely,\nYour name\nYour office"} />
      <Button type="submit" disabled={pending || text === signature} className="self-start">Save signature</Button>
      <Err text={error} />
    </form>
  );
}

export function DisconnectButton({ id }: { id: string }) {
  return <TextActionButton act={() => disconnectMailboxAction(id)}>Disconnect</TextActionButton>;
}

const BulkContext = createContext<{ selected: string[]; toggle: (id: string) => void } | null>(null);

export function BulkMail({ ids, team, children }: { ids: string[]; team: Person[]; children: ReactNode }) {
  const { pending, error, run } = useRun();
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const clear = () => setSelected([]);
  const all = ids.length > 0 && selected.length === ids.length;
  return (
    <BulkContext value={{ selected, toggle }}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line py-3">
        <label className="flex items-center gap-2.5 text-sm text-ink">
          <input type="checkbox" className="size-4" checked={all} onChange={() => setSelected(all ? [] : ids)} />
          Select all on this page
        </label>
        {selected.length > 0 && (
          <>
            <span className="text-sm font-semibold text-ink tabular">{selected.length} selected</span>
            <button type="button" disabled={pending} className={TEXT_ACTION} onClick={() => run(() => bulkTriageAction(selected, "done"), clear)}>
              Mark done
            </button>
            <Select aria-label="Hand selected mail to" className="w-52" disabled={pending} value=""
              onChange={(e) => e.target.value && run(() => bulkAssignAction(selected, e.target.value), clear)}>
              <option value="">Hand to</option>
              <TeamOptions team={team} />
            </Select>
          </>
        )}
        <Err text={error} />
      </div>
      {children}
    </BulkContext>
  );
}

export function BulkCheck({ id, label }: { id: string; label: string }) {
  const ctx = use(BulkContext);
  if (!ctx) return null;
  return <input type="checkbox" aria-label={`Select ${label}`} className="mt-1.5 size-4" checked={ctx.selected.includes(id)} onChange={() => ctx.toggle(id)} />;
}

const DISTRICT_CHOICES: [DistrictStatus | "", string][] = [
  ["in_district", "In district"],
  ["outside", "Outside the district"],
  ["out_of_state", "Out of state"],
  ["", "Not sure"],
];

export function DistrictControls({ id, status }: { id: string; status: DistrictStatus | null }) {
  const { pending, error, run } = useRun();
  return (
    <div className="flex flex-col gap-1">
      <Select aria-label="District" disabled={pending} value={status ?? ""}
        onChange={(e) => run(() => contactDistrictAction(id, (e.target.value || null) as DistrictStatus | null))}>
        {DISTRICT_CHOICES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </Select>
      <Err text={error} />
    </div>
  );
}

export function AddressForm({ id }: { id: string }) {
  const { pending, error, run } = useRun();
  const [text, setText] = useState("");
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => {
      e.preventDefault();
      run(() => contactAddressAction(id, text), () => setText(""));
    }}>
      <Input aria-label="Street address" value={text} onChange={(e) => setText(e.target.value)} placeholder="12 Main St, Town, ST 30000" />
      <Button type="submit" disabled={pending || !text.trim()} className="self-start">Add address</Button>
      <Err text={error} />
    </form>
  );
}

export function AddressLookupSwitch({ enabled }: { enabled: boolean }) {
  return <SwitchButton act={() => addressLookupAction(!enabled)}>{enabled ? "Turn district lookup off" : "Turn district lookup on"}</SwitchButton>;
}

export function FormLetterSettings({ overlap, minWords }: { overlap: number; minWords: number }) {
  const { pending, error, run } = useRun();
  const [percent, setPercent] = useState(String(Math.round(overlap * 100)));
  const [words, setWords] = useState(String(minWords));
  return (
    <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => {
      e.preventDefault();
      run(() => formLetterSettingsAction({ overlap: Number(percent) / 100, minWords: Number(words) }));
    }}>
      <Field label="Shared wording, percent">
        <Input type="number" min={50} max={95} value={percent} onChange={(e) => setPercent(e.target.value)} className="max-w-48" />
      </Field>
      <Field label="Shortest letter, words">
        <Input type="number" min={8} max={100} value={words} onChange={(e) => setWords(e.target.value)} className="max-w-48" />
      </Field>
      <Button type="submit" disabled={pending}>Save</Button>
      <Err text={error} />
    </form>
  );
}

export function AiGuidanceForm({ guidance }: { guidance: string }) {
  const { pending, error, run } = useRun();
  const [text, setText] = useState(guidance);
  return (
    <form className="flex max-w-3xl flex-col gap-3" onSubmit={(e) => {
      e.preventDefault();
      run(() => aiGuidanceAction(text));
    }}>
      <Textarea aria-label="Notes for AI reading" rows={5} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="Our district's biggest issues, local names, and words people here use" />
      <Button type="submit" disabled={pending || text === guidance} className="self-start">Save notes</Button>
      <Err text={error} />
    </form>
  );
}
