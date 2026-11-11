"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/app/(app)/_lib/action";
import { can, type OfficeContext } from "@/server/authz/context";
import { forbidden } from "@/server/errors";
import {
  addSenderRule,
  centerEnabled,
  checkMailNow,
  confirmSender,
  openCaseFromAsk,
  rejectSender,
  restoreFromLedger,
  setAddressLookup,
  setAiGuidance,
  setAiProcessing,
  setAskStatus,
  setFormLetterSettings,
  setInternalDomains,
  setReplySignature,
  setSenderRuleStatus,
} from "@/server/services/center";
import { addContactAddress, setContactDistrict } from "@/server/services/district";
import { addCaseNote, updateCase } from "@/server/services/cases";
import { addContactNote } from "@/server/services/contacts";
import { addMessageNote, assignMessage, setBillLink, setIssueLabel, setPosition, setTriageStatus } from "@/server/services/corrections";
import { searchBillsByText } from "@/server/services/legislation";
import { saveAgency, saveIssue, setAgencyActive, setAiDailyLimit, setIssueActive, setTaggingLevels } from "@/server/services/reading";
import { approveReplyDraft, createReplyDraft, discardReplyDraft, markReplySent, sendReplyDraft, updateReplyDraft } from "@/server/services/replies";
import { turnOffSending, turnOnSending } from "@/server/email/sending";
import {
  configureMailbox,
  connectMicrosoftApplication,
  connectPasswordMailbox,
  describeMailbox,
  disconnectMailbox,
  startMailboxConnection,
} from "@/server/email/connections";
import type { CasePriority, CaseStatus, DistrictStatus, Position, SenderRuleKind } from "@/server/db/schema";

async function requireCenterAccess(ctx: OfficeContext) {
  if (!can(ctx, "inbox.read") || !(await centerEnabled(ctx.orgId))) throw forbidden();
}

// Each action re-checks the session, portal access, then its own permission.
async function center<T>(fn: (ctx: OfficeContext) => Promise<T>) {
  const r = await act(async (ctx) => {
    await requireCenterAccess(ctx);
    return fn(ctx);
  });
  revalidatePath("/constituent-center", "layout");
  return r;
}

export async function saveIssueAction(input: { key?: string; parentKey?: string | null; label: string; keywords: string[] }) {
  return center((ctx) => saveIssue(ctx, input));
}

export async function issueActiveAction(key: string, active: boolean) {
  return center((ctx) => setIssueActive(ctx, key, active));
}

export async function saveAgencyAction(input: { id?: string; name: string; abbreviation?: string; domains: string[] }) {
  return center((ctx) => saveAgency(ctx, input));
}

export async function agencyActiveAction(id: string, active: boolean) {
  return center((ctx) => setAgencyActive(ctx, id, active));
}

export async function taggingLevelsAction(levels: { issue: number; position: number; billMatch: number; messageType: number }) {
  return center((ctx) => setTaggingLevels(ctx, levels));
}

export async function aiLimitAction(limit: number) {
  return center((ctx) => setAiDailyLimit(ctx, limit));
}

export async function issueTagAction(messageId: string, issueKey: string, decision: "confirm" | "reject") {
  return center((ctx) => setIssueLabel(ctx, messageId, issueKey, decision));
}

export async function billLinkAction(messageId: string, reference: string, billId: string | null) {
  return center((ctx) => setBillLink(ctx, messageId, reference, billId));
}

export async function billStanceAction(messageId: string, reference: string, position: Position) {
  return center((ctx) => setPosition(ctx, messageId, `bill:${reference}`, position));
}

export async function findBillsAction(q: string) {
  return act(async (ctx) => {
    await requireCenterAccess(ctx);
    return searchBillsByText(ctx, q, 6);
  });
}

export async function askStatusAction(id: string, status: "handled" | "dismissed" | "open") {
  return center((ctx) => setAskStatus(ctx, id, status));
}

export async function caseFromAskAction(id: string, input: { title: string; category: string; assignedTo: string | null; agencyId: string | null }) {
  return center(async (ctx) => (await openCaseFromAsk(ctx, id, input)).id);
}

export async function confirmSenderAction(messageId: string) {
  return center((ctx) => confirmSender(ctx, messageId));
}

export async function rejectSenderAction(messageId: string) {
  return center((ctx) => rejectSender(ctx, messageId));
}

export async function restoreAction(ledgerId: string) {
  return center((ctx) => restoreFromLedger(ctx, ledgerId));
}

export async function assignAction(messageId: string, userId: string | null) {
  return center((ctx) => assignMessage(ctx, messageId, userId));
}

export async function triageAction(messageId: string, status: "new" | "in_progress" | "done") {
  return center((ctx) => setTriageStatus(ctx, [messageId], status));
}

export async function messageNoteAction(messageId: string, body: string) {
  return center(async (ctx) => {
    await addMessageNote(ctx, messageId, body);
  });
}

export async function draftReplyAction(messageId: string) {
  return center(async (ctx) => {
    await createReplyDraft(ctx, messageId);
  });
}

export async function saveReplyAction(id: string, body: string) {
  return center((ctx) => updateReplyDraft(ctx, id, body));
}

export async function approveReplyAction(id: string) {
  return center((ctx) => approveReplyDraft(ctx, id));
}

export async function sentReplyAction(id: string) {
  return center((ctx) => markReplySent(ctx, id));
}

export async function sendReplyAction(id: string) {
  return center((ctx) => sendReplyDraft(ctx, id));
}

export async function sendingOnAction(id: string, acknowledged: boolean) {
  return center(async (ctx) => (await turnOnSending(ctx, id, acknowledged)).url);
}

export async function sendingOffAction(id: string) {
  return center((ctx) => turnOffSending(ctx, id));
}

export async function checkMailAction() {
  return center((ctx) => checkMailNow(ctx));
}

export async function signatureAction(text: string) {
  return center((ctx) => setReplySignature(ctx, text));
}

export async function discardReplyAction(id: string) {
  return center((ctx) => discardReplyDraft(ctx, id));
}

export async function updateCaseAction(id: string, patch: { status?: CaseStatus; priority?: CasePriority; assignedTo?: string | null }) {
  return center((ctx) => updateCase(ctx, id, patch));
}

export async function caseNoteAction(id: string, body: string, visibility: "office" | "private") {
  return center(async (ctx) => {
    await addCaseNote(ctx, id, body, visibility);
  });
}

export async function contactNoteAction(id: string, body: string, visibility: "office" | "private") {
  return center(async (ctx) => {
    await addContactNote(ctx, id, body, visibility);
  });
}

export async function addRuleAction(kind: SenderRuleKind, value: string, reason: string) {
  return center((ctx) => addSenderRule(ctx, { kind, value, reason }));
}

export async function ruleStatusAction(id: string, status: "active" | "retired") {
  return center((ctx) => setSenderRuleStatus(ctx, id, status));
}

export async function aiProcessingAction(enabled: boolean) {
  return center((ctx) => setAiProcessing(ctx, enabled));
}

export async function internalDomainsAction(text: string) {
  return center((ctx) => setInternalDomains(ctx, text.split(/[\s,]+/)));
}

export async function connectOAuthAction(provider: "google" | "microsoft", acknowledged: boolean) {
  return center((ctx) => startMailboxConnection(ctx, provider, acknowledged));
}

export async function connectApplicationAction(input: { tenantId: string; mailbox: string; acknowledged: boolean }) {
  return center(async (ctx) => (await connectMicrosoftApplication(ctx, input)).next);
}

export async function describeMailboxAction(email: string) {
  return center((ctx) => describeMailbox(ctx, email));
}

export async function connectPasswordAction(input: { email: string; password: string; acknowledged: boolean }) {
  return center(async (ctx) => (await connectPasswordMailbox(ctx, input)).next);
}

type Folder = { id: string; name: string };

export async function configureMailboxAction(id: string, input: { folders: Folder[]; importFrom: string; sentFolder?: Folder | null }) {
  return center((ctx) => configureMailbox(ctx, id, input));
}

export async function disconnectMailboxAction(id: string) {
  return center((ctx) => disconnectMailbox(ctx, id));
}

const BULK_LIMIT = 200;

export async function bulkTriageAction(ids: string[], status: "done" | "in_progress") {
  return center((ctx) => setTriageStatus(ctx, ids.slice(0, BULK_LIMIT), status));
}

export async function bulkAssignAction(ids: string[], userId: string | null) {
  return center(async (ctx) => {
    for (const id of ids.slice(0, BULK_LIMIT)) await assignMessage(ctx, id, userId);
  });
}

export async function contactDistrictAction(id: string, status: DistrictStatus | null) {
  return center((ctx) => setContactDistrict(ctx, id, status));
}

export async function contactAddressAction(id: string, text: string) {
  return center((ctx) => addContactAddress(ctx, id, text));
}

export async function addressLookupAction(enabled: boolean) {
  return center((ctx) => setAddressLookup(ctx, enabled));
}

export async function formLetterSettingsAction(input: { overlap: number; minWords: number }) {
  return center((ctx) => setFormLetterSettings(ctx, input));
}

export async function aiGuidanceAction(text: string) {
  return center((ctx) => setAiGuidance(ctx, text));
}
