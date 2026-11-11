import type { Metadata } from "next";
import { Kbd, PageHeader } from "@/components/ui";
import { Section } from "@/components/ui/blocks";

export const metadata: Metadata = { title: "Help" };

const SHORTCUTS: [string, string][] = [
  ["⌘K / Ctrl K", "Search bills, legislators and committees, or jump to a page"],
];

export default function HelpPage() {
  return (
    <>
      <PageHeader title="Help" meta="Using the system" />
      <div className="wrap">
        <div>
          <Section title="Keyboard">
            <dl className="grid grid-cols-[140px_1fr] gap-y-3 text-sm">
              {SHORTCUTS.map(([k, d]) => (
                <div key={k} className="contents">
                  <dt>
                    <Kbd>{k}</Kbd>
                  </dt>
                  <dd className="text-ink-2">{d}</dd>
                </div>
              ))}
            </dl>
          </Section>
          <Section title="Searching">
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-ink-2">
              <li>Type a bill number in any form: HB 142, hb142 or H.B. 142.</li>
              <li>Words search bill titles and summaries. A legislator&apos;s name finds bills they sponsor.</li>
              <li>Click a code section on a bill page to list every bill that changes it.</li>
            </ul>
          </Section>
          <Section title="How bills are connected">
            <dl className="flex flex-col gap-3 text-sm">
              <div>
                <dt className="font-semibold text-ink">Per the legislature&apos;s record</dt>
                <dd className="text-ink-2">Links the source publishes: same as, similar to, replaces, carried over.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Companion bill</dt>
                <dd className="text-ink-2">A bill in the other chamber this session with nearly the same title.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Earlier or later version</dt>
                <dd className="text-ink-2">A bill from another session with nearly the same title.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Both change a code section</dt>
                <dd className="text-ink-2">The bills cite the same section of state code, or the same chapter (a weaker link).</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Linked by your office</dt>
                <dd className="text-ink-2">A connection a staff member made, with their note.</dd>
              </div>
            </dl>
          </Section>
          <Section title="Tools">
            <dl className="flex flex-col gap-3 text-sm">
              <div>
                <dt className="font-semibold text-ink">Whip count</dt>
                <dd className="text-ink-2">Open a bill and choose Whip count. Members start from their latest recorded vote on the bill, then sponsorship. Your office&apos;s call replaces either; click it again to clear it.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Scorecards</dt>
                <dd className="text-ink-2">Chamber passage and committee approval votes on bills where your office has a Support or Oppose position. Amendment and procedural votes are left out. A percentage appears once a member has three yes or no votes.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Prep sheets</dt>
                <dd className="text-ink-2">Choose Prep sheet on any hearing in Calendar or Today, then print or save it as a PDF.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Alerts</dt>
                <dd className="text-ink-2">Your office is notified when a bill filed after the alert was set matches its keyword, code section, subject or sponsor.</dd>
              </div>
            </dl>
          </Section>
          <Section title="Connecticut data">
            <p className="max-w-[68ch] text-sm text-ink-2">Bills, actions, sponsors, subjects, committees and members come from the Connecticut General Assembly&apos;s published data files for the 2026 session, and bill text from its document library. Floor roll calls and committee tally sheets come from the Assembly&apos;s public file server. The sheets do not name what a Senate vote was on, so it is worked out from that day&apos;s actions on the bill. Public hearings show the date; the files do not give a time or room.</p>
          </Section>
          <Section title="Tracking">
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-ink-2">
              <li>Every bill has Support, Oppose, Neutral and Watch buttons. One click records your office&apos;s position and adds the bill to Tracked. Watch tracks it with no position.</li>
              <li>On a bill&apos;s page, Your office holds the priority, why you track it, who is handling it, the next step and when it is due. Follow-ups appear on Today.</li>
              <li>Stop tracking is on the bill&apos;s page and on each row of Tracked.</li>
              <li>Notify me sends you alone a notification when a bill moves.</li>
              <li>Bill brief prints a summary of any bill with your office&apos;s position. Email and Call use the official details the legislature publishes for each member.</li>
              <li>Bill text is stored automatically for tracked bills.</li>
            </ul>
          </Section>
          <Section title="Signing in">
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-ink-2">
              <li>An owner or chief of staff adds people on Team and gives each one a temporary password. The first time they sign in they are asked to choose their own.</li>
              <li>If someone forgets their password, Team has Reset password beside their name. It ends every sign-in they had and sets a new temporary password.</li>
              <li>If someone loses the phone with their authenticator app, Team has Reset two-step. They set it up again the next time they sign in.</li>
              <li>You change your own password in Settings, and your own two-step verification from the menu under your name.</li>
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}
