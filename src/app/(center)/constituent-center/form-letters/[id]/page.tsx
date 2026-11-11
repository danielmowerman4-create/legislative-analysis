import { requireCenter } from "@/server/auth/center";
import { orNotFound } from "@/server/auth/next";
import { getFormLetter } from "@/server/services/center";
import { BackLink, Block, mailHref, NoteRows, ROOT } from "@/components/center/parts";
import Link from "next/link";
import { shortDate } from "@/lib/format";

export default async function FormLetterPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireCenter();
  const { id } = await params;
  const d = await orNotFound(getFormLetter(ctx, id));
  const withNote = d.members.filter((m) => m.note);
  const without = d.members.filter((m) => !m.note);
  const first = shortDate(d.cluster.firstSeenAt);
  const last = shortDate(d.cluster.lastSeenAt);
  return (
    <div className="pt-6">
      <BackLink href={`${ROOT}/form-letters`}>Form letters</BackLink>
      <h1 className="display mt-5 max-w-[30ch] text-[34px] text-ink lg:text-[42px]">{d.subject}</h1>
      <p className="mt-2 text-base text-ink-2">
        Sent by {d.people} people, {first === last ? last : `${first} to ${last}`}
        {d.unconfirmed > 0 ? `. ${d.unconfirmed} more could not be confirmed` : ""}
      </p>

      {withNote.length > 0 && (
        <Block title="Wrote more than the letter"><NoteRows items={withNote} /></Block>
      )}

      <Block title="The letter">
        <div className="sheet-stack mt-6 max-w-[46rem]"><div className="sheet sheet-plain letter text-ink">{d.letter}</div></div>
      </Block>

      <Block title="Everyone else">
        <ul className="columns-1 gap-10 text-base text-ink md:columns-2">
          {without.map((m) => (
            <li key={m.id} className="break-inside-avoid py-1">
              <Link href={mailHref(m.id)} className="transition-colors hover:text-ink-2">{m.claimedName ?? m.fromName ?? m.fromAddress}</Link>
              {m.senderTrust !== "verified" && m.senderTrust !== "relay" && <span className="ml-2 text-sm text-warn-ink">Sender not confirmed</span>}
            </li>
          ))}
        </ul>
      </Block>
    </div>
  );
}
