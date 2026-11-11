import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getEnv } from "../../env";
import { logger } from "../../logger";
import { CT_SESSION } from "../connecticut";
import { buildConnecticutSession, pdfToBillText, type CtSnapshot } from "../connecticut-build";
import { fetchFromCga } from "../connecticut-fetch";
import { liveCtSource } from "../connecticut-live";
import type { ChangedBill, LegislativeProvider, NormalizedBill, NormalizedSession } from "../types";

const dataFile = (name: string) => join(process.cwd(), "data", "connecticut", name);

// The sidecar gives the build date without loading the whole session.
let builtAt: Date | null = null;
function snapshotDate() {
  builtAt ??= new Date((JSON.parse(readFileSync(dataFile("2026.meta.json"), "utf8")) as { builtAt: string }).builtAt);
  return builtAt;
}

let loaded: CtSnapshot | null = null;
function snapshot() {
  loaded ??= JSON.parse(gunzipSync(readFileSync(dataFile("2026.json.gz"))).toString("utf8")) as CtSnapshot;
  return loaded;
}

const readsLive = () => getEnv().CT_SOURCE === "live" && getEnv().APP_ENV !== "test";
// One refresh at a time: the first reads the whole session and can outlast the hour.
let refreshing = false;

export class ConnecticutProvider implements LegislativeProvider {
  readonly key = "ctga" as const;
  readonly wholeSession = true;
  private live = readsLive() ? liveCtSource() : null;
  private built: CtSnapshot | null = null;

  get snapshotBuiltAt() {
    return this.live ? undefined : snapshotDate();
  }

  private async session() {
    if (!this.live) return snapshot();
    if (!this.built) {
      const { snapshot: built, stats } = await buildConnecticutSession(this.live, { onProgress: (line) => logger.info("connecticut.refresh", { line }) });
      const read = await this.live.checkAgainstRecord(built);
      logger.info("connecticut.refresh_read", {
        ...read, requests: stats.requests, unreadNotes: stats.fiscalStats.unread.length, unmatched: stats.unmatched.length,
        voteProblems: stats.voteProblems.length, problems: stats.problems.length,
      });
      this.built = built;
    }
    return this.built;
  }

  isBusy() {
    return refreshing;
  }

  async hasNews() {
    if (!this.live) return true;
    refreshing = await this.live.hasNews();
    return refreshing;
  }

  async finished(complete: boolean) {
    if (!this.live) return;
    refreshing = false;
    this.built = null;
    if (complete) await this.live.remember();
  }

  async listSessions() {
    return [CT_SESSION];
  }

  async listChangedBills(_j: string, session: NormalizedSession, _since: Date | null, known: Map<string, string | null>): Promise<ChangedBill[]> {
    return (await this.session()).bills
      .filter((b) => b.sessionProviderId === session.providerId && known.get(b.providerBillId) !== b.changeHash)
      .map((b) => ({ providerBillId: b.providerBillId, changeHash: b.changeHash }));
  }

  async getBill(_j: string, id: string) {
    const data = await this.session();
    const b = data.bills.find((x) => x.providerBillId === id);
    if (!b) throw new Error(`Connecticut bill ${id} is not in the session`);
    return this.withTexts(data, b);
  }

  async bulkBills(_j: string, session: NormalizedSession) {
    const data = await this.session();
    return data.bills.filter((b) => b.sessionProviderId === session.providerId).map((b) => this.withTexts(data, b));
  }

  async listPeople() {
    return (await this.session()).people;
  }

  async getRollCallVotes(providerRollCallId: string) {
    return (await this.session()).rollCallVotes[providerRollCallId] ?? [];
  }

  async getVersionText(_j: string, version: { providerVersionId: string; url: string | null }) {
    if (!version.url) return null;
    const res = await fetchFromCga(version.url);
    if (!res.ok || !/pdf/i.test(res.contentType)) return null;
    return pdfToBillText(res.bytes);
  }

  private withTexts(data: CtSnapshot, b: NormalizedBill): NormalizedBill {
    return { ...b, versions: b.versions.map((v) => ({ ...v, text: data.versionTexts[v.providerVersionId] })) };
  }
}
