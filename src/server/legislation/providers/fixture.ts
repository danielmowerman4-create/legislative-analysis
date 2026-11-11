import { createHash } from "node:crypto";
import type { ChangedBill, LegislativeProvider, NormalizedBill, NormalizedPerson, NormalizedSession } from "../types";

type FixtureVote = { name: string; providerPersonId: string | null; vote: "yes" | "no" | "not_voting" | "absent" | "excused" | "other" };
export type FixtureDataset = {
  sessions: NormalizedSession[];
  bills: (NormalizedBill & { versionTexts?: Record<string, string> })[];
  people?: NormalizedPerson[];
  rollCallVotes?: Record<string, FixtureVote[]>;
};

export class FixtureProvider implements LegislativeProvider {
  readonly key = "fixture" as const;
  constructor(public data: FixtureDataset) {}

  static hash(b: NormalizedBill) {
    return createHash("sha1").update(JSON.stringify({ ...b, changeHash: null })).digest("hex").slice(0, 16);
  }

  async listSessions(): Promise<NormalizedSession[]> {
    return this.data.sessions;
  }

  async listChangedBills(_j: string, session: NormalizedSession, _since: Date | null, known: Map<string, string | null>): Promise<ChangedBill[]> {
    return this.data.bills
      .filter((b) => b.sessionProviderId === session.providerId)
      .map((b) => ({ providerBillId: b.providerBillId, changeHash: FixtureProvider.hash(b) }))
      .filter((b) => known.get(b.providerBillId) !== b.changeHash);
  }

  async getBill(_j: string, id: string): Promise<NormalizedBill> {
    const b = this.data.bills.find((x) => x.providerBillId === id);
    if (!b) throw new Error(`Fixture bill ${id} not found`);
    return { ...b, changeHash: FixtureProvider.hash(b) };
  }

  async listPeople(): Promise<NormalizedPerson[]> {
    return this.data.people ?? [];
  }

  async getRollCallVotes(id: string): Promise<FixtureVote[]> {
    return this.data.rollCallVotes?.[id] ?? [];
  }

  async getVersionText(_j: string, v: { providerVersionId: string }): Promise<string | null> {
    for (const b of this.data.bills) if (b.versionTexts?.[v.providerVersionId] !== undefined) return b.versionTexts[v.providerVersionId];
    return null;
  }
}

let registered: FixtureProvider | null = null;
export function registerFixtureProvider(p: FixtureProvider | null) {
  registered = p;
}
export const registeredFixture = () => registered;
