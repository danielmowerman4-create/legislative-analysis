import { z } from "zod";
import { getEnv } from "../env";
import { ASK_KINDS, ASK_URGENCY, BILL_REQUESTS, MESSAGE_TYPES, POSITIONS, REQUESTED_ACTIONS } from "../classification/schema";

export type GenerateInput = { system: string; sources: { id: string; label: string; text: string }[]; task: string; maxTokens?: number };

export interface AiProvider {
  readonly model: string;
  classify(input: AiClassifyInput): Promise<AiClassification | null>;
  generate(input: GenerateInput): Promise<{ text: string; citedIds: string[] } | null>;
}

export type AiClassifyInput = {
  subject: string;
  // Masked with maskForModel(): the sender's own text only, never quoted mail.
  text: string;
  taxonomy: { key: string; label: string }[];
  billReferences: string[];
  issueTargets: string[];
  officeGuidance?: string | null;
};

export function aiClassificationSchema(taxonomyKeys: string[], targets: string[]) {
  const issueEnum = taxonomyKeys.length ? z.enum(taxonomyKeys as [string, ...string[]]) : z.string();
  const targetEnum = targets.length ? z.enum(targets as [string, ...string[]]) : z.string();
  return z.object({
    message_types: z.array(z.object({ type: z.enum(MESSAGE_TYPES), confidence: z.number() })),
    summary: z.string(),
    issues: z.array(z.object({ taxonomy_id: issueEnum, confidence: z.number(), evidence_quote: z.string() })),
    positions: z.array(z.object({
      target: targetEnum, position: z.enum(POSITIONS), confidence: z.number(), evidence_quote: z.string(), requested_action: z.enum(BILL_REQUESTS).nullable(),
    })),
    requested_actions: z.array(z.enum(REQUESTED_ACTIONS)),
    asks: z.array(z.object({ kind: z.enum(ASK_KINDS), summary: z.string(), urgency: z.enum(ASK_URGENCY), evidence_quote: z.string() })),
  });
}

export type AiClassification = z.infer<ReturnType<typeof aiClassificationSchema>>;

let override: AiProvider | null | undefined;

export function setAiProviderForTests(p: AiProvider | null | undefined) {
  override = p;
}

export async function getAiProvider(officeAiEnabled: boolean): Promise<AiProvider | null> {
  if (override !== undefined) return override;
  if (!officeAiEnabled || !getEnv().ANTHROPIC_API_KEY) return null;
  const { AnthropicProvider } = await import("./anthropic");
  return new AnthropicProvider();
}
