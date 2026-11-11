// npx tsx scripts/eval.ts [dev|test|both]
import { writeFileSync } from "node:fs";
import { evaluate } from "../tests/eval/run";
import { PIPELINE_VERSION } from "../src/server/classification/schema";

process.env.APP_ENV ??= "test";
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const which = (process.argv[2] ?? "both") as "dev" | "test" | "both";
  const splits = which === "both" ? (["dev", "test"] as const) : ([which] as const);
  const lines: string[] = [`# Classification evaluation`, ``, `Pipeline ${PIPELINE_VERSION}, rules only (no AI provider). Synthetic hand-labeled set in tests/eval/dataset.ts. Generated ${new Date().toISOString().slice(0, 10)}.`, ``];
  for (const s of splits) {
    const r = await evaluate(s);
    lines.push(
      `## ${s === "dev" ? "Dev split (rules tuned against it)" : "Test split (held out)"} · ${r.n} messages`,
      ``,
      `| Task | Precision | Recall | F1 |`,
      `|---|---|---|---|`,
      `| Message type | ${pct(r.types.precision)} | ${pct(r.types.recall)} | ${pct(r.types.f1)} |`,
      `| Issue tags (specific topics) | ${pct(r.issues.precision)} | ${pct(r.issues.recall)} | ${pct(r.issues.f1)} |`,
      `| Bill reference found | ${pct(r.billExtraction.precision)} | ${pct(r.billExtraction.recall)} | ${pct(r.billExtraction.f1)} |`,
      `| Requested actions | ${pct(r.actions.precision)} | ${pct(r.actions.recall)} | ${pct(r.actions.f1)} |`,
      ``,
      `| Measure | Result |`,
      `|---|---|`,
      `| Bill resolution correct (resolved / ambiguous / unmatched / out of state) | ${pct(r.billResolutionAccuracy)} |`,
      `| Auto-accepted bill links that are correct (target 95%) | ${pct(r.billAutoPrecision)} of ${r.billAuto} |`,
      `| Resolvable bills auto-linked correctly | ${pct(r.billAutoCoverage)} |`,
      `| Stated positions correct (all) | ${pct(r.positionAccuracy)} |`,
      `| Auto-accepted positions that are correct (target 95%) | ${pct(r.positionAutoPrecision)} of ${r.positionAuto} |`,
      `| Labeled positions auto-accepted correctly | ${pct(r.positionAutoCoverage)} |`,
      ``,
      `| Position | Precision | Recall |`,
      `|---|---|---|`,
      ...Object.entries(r.positionsPerClass).map(([k, v]) => `| ${k} | ${pct(v.precision)} | ${pct(v.recall)} |`),
      ``,
      `Errors:`,
      ``,
      ...r.results.filter((x) => x.errors.length).map((x) => `- ${x.c.id} (${x.c.scenario}): ${x.errors.join("; ")}`),
      ``,
    );
  }
  lines.push(`Caveat: the same person wrote the rules and the labels, and the set is small and synthetic. Treat these numbers as a regression baseline, not as expected accuracy on an office's real mail. Measure against a labeled sample of real correspondence before relying on auto-acceptance.`);
  writeFileSync("EVAL_REPORT.md", lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

void main();
