import { createHash } from "node:crypto";
import type { AutoAcceptThresholds } from "../db/schema";
import type { AiClassification, AiProvider } from "../ai/provider";
import { maskForModel, preprocess, type Preprocessed } from "./preprocess";
import { compileTaxonomy, extractIssues, type TaxonomyNode } from "./issues";
import { extractBillMentions, type BillCandidate } from "./bills";
import { buildBillNameIndex, findBillNames, NO_SESSION, referencesToLoad, resolveMentions, type SessionScope } from "./bill-matching";
import { detectPositions, type PositionTarget } from "./positions";
import {
  classifyMessageType,
  detectCommitments,
  detectRequestedActions,
  detectSensitive,
  firstSentence,
  INHERITED_SUBJECT,
  ruleSummary,
  suggestCase,
  type MessageEnvelope,
  type OfficeRulesContext,
} from "./rules";
import { detectUrgency } from "./urgency";
import { extractAsks } from "./asks";
import { billRequestIn } from "./categories";
import { classificationSchema, PIPELINE_VERSION, verifyEvidence, type ClassificationResult, type Evidence, type MessageTypeKey } from "./schema";

export type PipelineDeps = {
  taxonomy: TaxonomyNode[];
  officeJurisdiction: string;
  office: OfficeRulesContext;
  thresholds: AutoAcceptThresholds;
  findBillCandidates: (references: string[]) => Promise<BillCandidate[]>;
  sessionScope?: (at: Date) => Promise<SessionScope>;
  ai: AiProvider | null;
  aiWithheld?: string | null;
  officeGuidance?: string | null;
};

export type PipelineInput = {
  envelope: MessageEnvelope;
  bodyText: string | null;
  bodyHtml: string | null;
  formLetter?: { personalNote: string | null };
};

const POLICY_TYPES: MessageTypeKey[] = ["constituent_policy", "organization"];
const NON_CORRESPONDENCE: MessageTypeKey[] = ["newsletter_automated", "spam", "legislative_staff"];

export const inputHash = (input: PipelineInput) =>
  createHash("sha256").update(`${PIPELINE_VERSION}\n${input.envelope.subject}\n${input.bodyText ?? ""}\n${input.bodyHtml ?? ""}`).digest("hex");

function locate(quote: string, text: string): Evidence | null {
  const q = quote.trim();
  if (q.length < 3) return null;
  const i = text.indexOf(q);
  return i >= 0 ? { start: i, end: i + q.length, text: q, field: "substantive" } : null;
}

export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<{ result: ClassificationResult; pre: Preprocessed }> {
  const { envelope } = input;
  const pre = preprocess({ bodyText: input.bodyText, bodyHtml: input.bodyHtml });
  const subject = envelope.subject ?? "";
  const warnings: string[] = [];
  const reviewReasons: string[] = [];

  const compiled = compileTaxonomy(deps.taxonomy);
  const issueHits = extractIssues(compiled, pre.substantive, subject);

  const numbers = extractBillMentions(pre.substantive, subject);
  const scope = envelope.direction === "inbound" && deps.sessionScope ? await deps.sessionScope(envelope.sentAt) : NO_SESSION;
  const nameIndex = buildBillNameIndex(scope.bills);
  const names = findBillNames(pre.substantive, subject, nameIndex, deps.officeJurisdiction);
  const references = referencesToLoad(numbers, names, scope);
  const candidates = references.length ? await deps.findBillCandidates(references) : [];
  const matched = resolveMentions({
    numbers, names, candidates, scope, index: nameIndex,
    ctx: {
      officeJurisdiction: deps.officeJurisdiction, messageDate: envelope.sentAt, substantive: pre.substantive, subject,
      issueKeys: issueHits.map((h) => h.key), currentSessions: scope.sessions,
    },
  });
  const mentions = matched.map((m) => m.mention);
  const resolutions = matched.map((m) => m.resolution);

  const inheritedSubject = INHERITED_SUBJECT.test(subject);
  const raised = inheritedSubject ? issueHits.filter((h) => h.evidence.some((e) => e.field !== "subject")) : issueHits;
  let types = classifyMessageType(envelope, pre.substantive, pre.signature, deps.office, matched.some((m) => !m.suggested), raised.length);
  if (envelope.direction === "outbound") types = [{ type: "other", confidence: 0.99, signals: ["sent by the office"] }];

  const bodySpans = (evidence: Evidence[]) => evidence.filter((e) => e.field !== "subject");
  const targets: PositionTarget[] = [
    ...mentions
      .filter((_, i) => resolutions[i].status !== "out_of_jurisdiction")
      .map((m) => ({ key: `bill:${m.reference}`, type: "bill" as const, issueKey: null, billReference: m.reference, spans: bodySpans(m.evidence) })),
    ...issueHits.map((h) => ({ key: `issue:${h.key}`, type: "issue" as const, issueKey: h.key, billReference: null, spans: bodySpans(h.evidence) })),
  ];
  const ruleTypes = types.map((t) => t.type);
  const setAside = ruleTypes.some((t) => NON_CORRESPONDENCE.includes(t) && types.find((x) => x.type === t)!.confidence >= 0.85);
  const correspondence = envelope.direction === "inbound" && !setAside;
  const speaksForThemselves = !["media", "vendor", "government_agency"].includes(ruleTypes[0]);
  const positions = correspondence && speaksForThemselves ? detectPositions(pre.substantive, targets) : [];
  if (positions.length && !inheritedSubject) {
    const inSubject = mentions.flatMap((m) => {
      const spans = m.evidence.filter((e) => e.field === "subject").map((e) => ({ ...e, field: "substantive" as const }));
      return spans.length ? [{ key: `bill:${m.reference}`, type: "bill" as const, issueKey: null, billReference: m.reference, spans }] : [];
    });
    const stated = inSubject.length ? detectPositions(subject, inSubject).filter((p) => p.position === "support" || p.position === "oppose") : [];
    for (const s of stated) {
      const body = positions.find((p) => p.target.key === s.target.key);
      if (!body || body.position !== "unclear" || body.evidence.length) continue;
      body.position = s.position;
      body.confidence = Math.min(s.confidence, 0.88);
      body.evidence = s.evidence.map((e) => ({ ...e, field: "subject" as const }));
      body.notes = "Stated in the subject line.";
    }
  }

  const formLetter = input.formLetter ?? null;
  const note = formLetter?.personalNote ?? "";
  const inScope = (s: string) => !formLetter || note.includes(s);
  if (deps.aiWithheld) reviewReasons.push(deps.aiWithheld);

  let ai: AiClassification | null = null;
  let aiStatus: ClassificationResult["ai_status"] = "not_used";
  const aiText = formLetter ? note : pre.substantive;
  if (deps.ai && correspondence && aiText.length > 0) {
    ai = await deps.ai.classify({
      subject: maskForModel(subject),
      text: maskForModel(aiText),
      taxonomy: deps.taxonomy.filter((t) => t.isActive !== false).map((t) => ({ key: t.key, label: t.label })),
      billReferences: mentions.map((m) => m.reference),
      issueTargets: issueHits.map((h) => `issue:${h.key}`),
      officeGuidance: deps.officeGuidance,
    });
    aiStatus = ai ? "ok" : "failed";
    if (!ai) {
      warnings.push("AI stage unavailable for this message; rules only.");
      reviewReasons.push("The AI reading failed, so a person should read this.");
    }
  }
  // A quote found only in the masked text is dropped without a warning.
  const masked = maskForModel(pre.substantive);

  const issues: ClassificationResult["issues"] = issueHits.map((h) => ({
    taxonomy_id: h.key, confidence: h.confidence, source: "rule" as const, evidence: h.evidence,
  }));
  if (ai) {
    for (const a of ai.issues) {
      const ev = locate(a.evidence_quote, pre.substantive);
      const existing = issues.find((i) => i.taxonomy_id === a.taxonomy_id);
      if (existing) {
        existing.source = "ensemble";
        existing.confidence = Number(Math.min(0.98, Math.max(existing.confidence, a.confidence) + 0.03).toFixed(2));
        if (ev) existing.evidence.push(ev);
      } else if (ev && deps.taxonomy.some((t) => t.key === a.taxonomy_id)) {
        issues.push({ taxonomy_id: a.taxonomy_id, confidence: Number(Math.min(a.confidence, 0.84).toFixed(2)), source: "ai", evidence: [ev] });
      } else if (!ev && locate(a.evidence_quote, masked) === null) {
        warnings.push(`Dropped AI issue ${a.taxonomy_id}: evidence quote not found in message.`);
      }
    }
  }

  resolutions.forEach((r, i) => {
    const bill = r.status === "resolved" && r.confidence >= deps.thresholds.billMatch ? candidates.find((c) => c.id === r.billId) : undefined;
    if (!bill) return;
    for (const hit of extractIssues(compiled, "", bill.title)) {
      if (!hit.isLeaf || issues.some((x) => x.taxonomy_id === hit.key)) continue;
      issues.push({ taxonomy_id: hit.key, confidence: 0.86, source: "rule", evidence: mentions[i].evidence });
    }
  });

  const positionOut: ClassificationResult["positions"] = positions.map((p) => ({
    target_type: p.target.type,
    issue_id: p.target.issueKey,
    bill_reference: p.target.billReference,
    position: p.position,
    confidence: p.confidence,
    source: "rule" as const,
    evidence: p.evidence,
    notes: p.notes,
    requested_action: p.target.type === "bill" ? billRequestIn(p.evidence.map((e) => e.text).join(" ")) : null,
  }));
  if (ai) {
    for (const a of ai.positions) {
      const isBill = a.target.startsWith("bill:");
      const key = a.target.slice(isBill ? 5 : 6);
      const rule = positionOut.find((p) => (isBill ? p.bill_reference === key : p.issue_id === key));
      const ev = locate(a.evidence_quote, pre.substantive);
      if (!rule) continue; // targets come from the rules; AI cannot add one
      rule.requested_action ??= a.requested_action ?? null;
      if (rule.position === a.position) {
        rule.source = "ensemble";
        rule.confidence = Number(Math.min(0.98, Math.max(rule.confidence, a.confidence) + 0.03).toFixed(2));
        if (ev && !rule.evidence.some((e) => e.start === ev.start)) rule.evidence.push(ev);
      } else if (rule.position === "unclear" && ev) {
        rule.position = a.position;
        rule.source = "ai";
        rule.confidence = Number(Math.min(a.confidence, 0.8).toFixed(2));
        rule.evidence = [ev];
        rule.notes = `AI reading; rules found no explicit stance. ${rule.notes ?? ""}`.trim();
      } else {
        rule.notes = `Rules read "${rule.position}", AI read "${a.position}". ${rule.notes ?? ""}`.trim();
        rule.confidence = Math.min(rule.confidence, 0.5);
        reviewReasons.push(`Rules and AI disagree on ${a.target}`);
      }
    }
  }

  if (ai) {
    for (const t of ai.message_types) {
      // A model's opinion never takes mail out of the queue.
      if (NON_CORRESPONDENCE.includes(t.type)) continue;
      const existing = types.find((x) => x.type === t.type);
      if (existing) existing.confidence = Math.min(0.99, Math.max(existing.confidence, t.confidence) + 0.02);
      else if (t.confidence >= 0.6 && envelope.direction === "inbound") types.push({ type: t.type, confidence: Math.min(t.confidence, 0.8), signals: ["AI"] });
    }
    types.sort((a, b) => b.confidence - a.confidence);
    if (types.length > 1 && types[0].type === "other") types.shift();
  }
  const typeKeys = types.map((t) => t.type);

  const actions = envelope.direction === "inbound" ? detectRequestedActions(pre.substantive, typeKeys) : ["none" as const];
  if (ai) for (const a of ai.requested_actions) if (a !== "none" && !actions.includes(a)) actions.push(a);
  const asksAboutBill = positionOut.some((p) => p.target_type === "bill" && p.position === "neutral" && p.evidence.some((e) => e.text.trim().endsWith("?")));
  if (envelope.direction === "inbound" && asksAboutBill && !actions.includes("legislation_info")) actions.push("legislation_info");
  if (actions.length > 1 && actions.includes("none")) actions.splice(actions.indexOf("none"), 1);

  const sensitive = envelope.direction === "inbound" ? detectSensitive(pre.substantive) : [];
  const caseSuggestion = envelope.direction === "inbound" ? suggestCase(typeKeys, pre.substantive, deps.office.agencies) : null;
  const commitments = envelope.direction === "outbound" ? detectCommitments(pre.substantive, envelope.sentAt) : [];

  const signals = envelope.direction === "inbound" ? detectUrgency(pre.substantive, envelope.sentAt, inScope) : [];
  const asks =
    envelope.direction === "inbound" && (correspondence || signals.length)
      ? extractAsks({
          text: pre.substantive, types: typeKeys, positions: positionOut, caseCategory: caseSuggestion?.category ?? null,
          signals, inScope, isFormLetter: Boolean(formLetter),
        })
      : [];
  if (ai) {
    for (const a of ai.asks.slice(0, 10)) {
      const ev = locate(a.evidence_quote, pre.substantive);
      if (!ev || !inScope(ev.text)) {
        warnings.push(`Dropped an AI ask (${a.kind}): its quote is not in the message.`);
        continue;
      }
      if (asks.some((x) => x.kind === a.kind && ev.start < x.evidence.end && x.evidence.start < ev.end)) continue;
      asks.push({ kind: a.kind, summary: a.summary.trim().slice(0, 300) || a.kind, urgency: a.urgency, due_at: null, source: "ai", evidence: ev });
    }
  }
  const rank = { routine: 0, soon: 1, urgent: 2 } as const;
  const top = [...asks].sort((a, b) => rank[b.urgency] - rank[a.urgency])[0];
  const urgency = {
    level: top?.urgency ?? ("routine" as const), reason: top && top.urgency !== "routine" ? top.summary : null,
    due_at: asks.find((a) => a.due_at)?.due_at ?? null,
  };
  if (urgency.level === "urgent") reviewReasons.push(`Urgent: ${urgency.reason}`);

  const th = deps.thresholds;
  const isPolicy = typeKeys.some((t) => POLICY_TYPES.includes(t));
  if (types[0].confidence < th.messageType && correspondence) reviewReasons.push("Message type uncertain");
  for (const r of resolutions) {
    if (r.status === "ambiguous") reviewReasons.push(`${r.reference}: ${r.notes}`);
    else if (r.status === "unmatched" && isPolicy) reviewReasons.push(`${r.reference}: not found in legislative data`);
    else if (r.status === "resolved" && r.confidence < th.billMatch) reviewReasons.push(`${r.reference}: match needs confirmation`);
  }
  if (isPolicy) {
    for (const p of positionOut) {
      if (p.target_type === "issue" && mentions.length > 0) continue;
      const label = p.bill_reference ?? p.issue_id;
      if (p.position === "mixed") reviewReasons.push(`${label}: mixed or conditional position`);
      else if (p.target_type === "bill" && p.position === "unclear") reviewReasons.push(`${label}: position unclear`);
      else if (p.position !== "unclear" && p.confidence < th.position) reviewReasons.push(`${label}: position below auto-accept confidence`);
    }
  }
  if (sensitive.length) reviewReasons.push(`Sensitive content: ${sensitive.join(", ")}`);
  if (pre.isForwardOnly) warnings.push("Forwarded without comment: forwarded text is not treated as the sender's position.");

  const taxonomyLabel = (k: string) => deps.taxonomy.find((t) => t.key === k)?.label ?? k;
  const aiSummary = ai?.summary && ai.summary.trim().length > 10 ? ai.summary.trim() : null;
  const baseSummary =
    aiSummary && !formLetter
      ? aiSummary.slice(0, 600)
      : ruleSummary({
          types: typeKeys,
          issueLabels: issues.map((i) => taxonomyLabel(i.taxonomy_id)),
          positions: positionOut
            .filter((p) => p.target_type === "bill")
            .map((p) => ({ label: p.bill_reference!, position: p.position, confidence: p.confidence })),
          actions,
          caseCategory: caseSuggestion?.category ?? null,
          firstSentence: firstSentence(pre.substantive),
          isForwardOnly: pre.isForwardOnly,
          fromOffice: envelope.direction === "outbound",
        });
  const read = formLetter
    ? (note ? `Form letter with a personal note: ${(aiSummary ?? note).slice(0, 480)}` : `Form letter. ${baseSummary}`.slice(0, 600))
    : baseSummary;
  const summary = urgency.level === "urgent" && urgency.reason ? `${urgency.reason}. ${read}`.slice(0, 600) : read;

  const result: ClassificationResult = {
    pipeline_version: PIPELINE_VERSION,
    mode: ai ? "rules+ai" : "rules",
    language: pre.language,
    message_type: types.map((t) => ({ type: t.type, confidence: Number(t.confidence.toFixed(2)), signals: t.signals })),
    summary: summary || "No text content.",
    summary_source: aiSummary ? "ai" : "rule",
    issues: issues.map((i) => ({ ...i, evidence: verifyEvidence(i.evidence, pre.substantive, subject) })),
    bill_references: resolutions.map((r, idx) => ({
      raw_reference: mentions[idx].raw,
      reference: r.reference,
      bill_id: r.billId,
      candidate_bill_ids: r.candidateIds,
      resolution_status: r.status,
      confidence: r.confidence,
      notes: r.notes,
      evidence: verifyEvidence(mentions[idx].evidence, pre.substantive, subject),
    })),
    positions: positionOut.map((p) => ({ ...p, evidence: verifyEvidence(p.evidence, pre.substantive, subject) })),
    requested_actions: actions,
    sensitive: { flagged: sensitive.length > 0, categories: sensitive },
    case_suggestion: caseSuggestion,
    commitments: commitments.map((c) => ({ text: c.text, due_hint: c.due ? c.due.toISOString() : null, evidence: c.evidence })),
    asks: asks.filter((a) => verifyEvidence([a.evidence], pre.substantive, subject).length > 0),
    urgency,
    ai_status: aiStatus,
    requires_staff_review: reviewReasons.length > 0,
    review_reasons: [...new Set(reviewReasons)],
    warnings,
  };
  return { result: classificationSchema.parse(result), pre };
}
