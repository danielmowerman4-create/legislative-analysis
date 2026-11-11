import type { ActionClass, BillRelationKind, BillStatus, CommitteeRole, LegislativeProviderKey, MemberContact } from "../db/schema";
import type { BillAnalysis } from "./connecticut-analysis";
import type { FiscalNote } from "./connecticut-fiscal";

export type { CommitteeRole };

export type StoredAnalysis = BillAnalysis & { url: string };
export type StoredFiscalNote = FiscalNote & { url: string };

export type NormalizedSession = { providerId: string; identifier: string; name: string; startDate: string | null; endDate: string | null; isSpecial: boolean };

export type NormalizedBill = {
  providerBillId: string; sessionProviderId: string; identifier: string; billType: string; number: number; chamber: "upper" | "lower" | "joint";
  title: string; officialSummary: string | null; analysis?: StoredAnalysis | null; fiscal?: StoredFiscalNote | null;
  status: BillStatus; statusText: string | null; statusDate: string | null; introducedAt: string | null; lastActionAt: string | null;
  lastActionText: string | null; effectiveDate: string | null; subjects: string[]; sourceUrls: { label: string; url: string }[];
  changeHash: string | null; sourceUpdatedAt: string | null;
  sponsors: {
    name: string; type: "primary" | "cosponsor"; providerPersonId: string | null; party: string | null; district: string | null; chamber: string | null;
  }[];
  actions: { providerKey: string; date: string; chamber: string | null; description: string; classification: ActionClass[] }[];
  versions: { providerVersionId: string; label: string; date: string | null; url: string | null; mimeType: string | null; text?: string }[];
  amendments: {
    providerAmendmentId: string; title: string; description: string | null; chamber: string | null; adopted: boolean | null; date: string | null;
    url: string | null;
  }[];
  votes: {
    providerRollCallId: string; date: string | null; chamber: string | null; motion: string; yes: number; no: number; other: number;
    passed: boolean | null; url: string | null;
  }[];
  committees: { providerCommitteeId: string; name: string; chamber: string | null; referredAt: string | null }[];
  events: { providerEventId: string; title: string; startsAt: string; location: string | null; kind: "hearing" | "floor" | "other" }[];
  relations?: { providerBillId: string; identifier: string; kind: BillRelationKind }[];
  codeSections?: string[];
};

export type NormalizedPerson = {
  providerPersonId: string; name: string; party: string | null; chamber: "upper" | "lower" | null; district: string | null;
  committeeRoles?: CommitteeRole[]; title?: string | null; contact?: MemberContact;
};

export type ChangedBill = { providerBillId: string; changeHash: string | null };
type MemberVote = { name: string; providerPersonId: string | null; vote: "yes" | "no" | "not_voting" | "absent" | "excused" | "other" };

export interface LegislativeProvider {
  readonly key: LegislativeProviderKey;
  readonly snapshotBuiltAt?: Date;
  readonly wholeSession?: boolean;
  isBusy?(): boolean; // a sync is running, so another must not be recorded as a check
  hasNews?(): Promise<boolean>;
  finished?(complete: boolean): Promise<void>; // complete: nothing failed and every bill loaded
  listSessions(jurisdiction: string): Promise<NormalizedSession[]>;
  listChangedBills(jurisdiction: string, session: NormalizedSession, since: Date | null, knownHashes: Map<string, string | null>): Promise<ChangedBill[]>;
  getBill(jurisdiction: string, providerBillId: string): Promise<NormalizedBill>;
  bulkBills?(jurisdiction: string, session: NormalizedSession): Promise<NormalizedBill[] | null>;
  readonly queries?: number;
  getVersionText(jurisdiction: string, version: { providerVersionId: string; url: string | null; mimeType: string | null }): Promise<string | null>;
  listPeople?(jurisdiction: string, session: NormalizedSession): Promise<NormalizedPerson[]>;
  getRollCallVotes?(providerRollCallId: string): Promise<MemberVote[]>;
}
