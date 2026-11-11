import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Wordmark } from "@/components/shell/brand";
import { getEnv } from "@/server/env";

export const metadata: Metadata = { title: "Privacy" };

// No sign-in: Google's consent screen links here and requires it.
export default async function PrivacyPage() {
  // The contact address is a deployment setting, so it is read per request and not at build.
  await connection();
  const contact = getEnv().CONTACT_EMAIL;
  return (
    <>
      <div className="wrap pt-6"><Link href="/login" aria-label="Legislative Analysis sign in"><Wordmark /></Link></div>
      <main className="wrap pt-14 pb-24">
        <div className="max-w-[68ch] text-base text-ink">
          <h1 className="anchor text-[72px] text-ink">Privacy</h1>
          <p className="mt-4 text-ink-2">Effective November 10, 2026</p>

          <Section title="What this app is">
            <p>Legislative Analysis is used by the staff of state legislative offices to track bills and to read, sort and answer the mail constituents send their legislator. Only people an office adds to its account can sign in.</p>
          </Section>

          <Section title="What we read from Gmail and Outlook">
            <p>A staff member can link their own mailbox. Linking asks Google or Microsoft for permission to read mail and nothing else (Gmail: <code>gmail.readonly</code>; Outlook: <code>Mail.Read</code>), plus the account&apos;s email address. The app reads only the folders the person chooses. It never changes, moves or deletes mail.</p>
            <p>Sending replies is a separate step that is off until the person who linked the mailbox turns it on. Turning it on asks for permission to send (Gmail: <code>gmail.send</code>; Outlook: <code>Mail.Send</code>). A reply is sent only after a person approves it and presses Send.</p>
            <p>If the person agrees to have their Sent folder watched, the app looks only at the recipients and subject of each sent message, and reads a message only when it answers a constituent letter the office already holds.</p>
          </Section>

          <Section title="How the mail is used">
            <p>Mail is used only to show it to the office&apos;s staff, tag it by issue and bill, place the writer in a district, and draft and send the replies staff approve. It is not sold, not used for advertising, and not used to train AI models.</p>
          </Section>

          <Section title="Who else sees it">
            <p>The mail is stored on the app&apos;s hosting provider. If an office turns on AI reading, the text of a letter is sent to Anthropic&apos;s Claude service to suggest tags, with Social Security numbers, birth dates and long account numbers masked first. Anthropic does not train on it. If an office turns on district lookup, only the writer&apos;s street address is sent to the U.S. Census Bureau&apos;s address lookup (or to Geocodio, where the server is set up with it). Nothing else is shared with anyone.</p>
          </Section>

          <Section title="How it is protected">
            <p>Each office sees only its own mail, enforced in the database. Within an office, what a person sees depends on their role. Sign-in keys for mailboxes are encrypted and never sent to the browser. Everything travels over encrypted connections.</p>
          </Section>

          <Section title="Keeping and deleting it">
            <p>Mail is kept for as long as the office uses the app, under the office&apos;s own records rules. Disconnecting a mailbox in Settings stops all reading from it. You can also remove the app&apos;s access at any time from your Google account (myaccount.google.com/permissions) or your Microsoft account.{contact && <> To have your data deleted, email <a href={`mailto:${contact}`} className="font-semibold underline underline-offset-4">{contact}</a>.</>}</p>
          </Section>

          <Section title="Google user data">
            <p>
              Legislative Analysis&apos;s use and transfer to any other app of information received from Google APIs will adhere to the{" "}
              <a href="https://developers.google.com/terms/api-services-user-data-policy" className="font-semibold underline underline-offset-4">
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
          </Section>

          {contact && (
            <Section title="Questions">
              <p>
                Email <a href={`mailto:${contact}`} className="font-semibold underline underline-offset-4">{contact}</a>.
              </p>
            </Section>
          )}
        </div>
      </main>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12 flex flex-col gap-4"><h2 className="display text-[28px] text-ink">{title}</h2>{children}</section>
  );
}
