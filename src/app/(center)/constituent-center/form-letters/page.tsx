import Link from "next/link";
import { requireCenter } from "@/server/auth/center";
import { listFormLetters } from "@/server/services/center";
import { NoRows, PageTitle, ROOT } from "@/components/center/parts";
import { Table, Td, Th } from "@/components/ui";
import { shortDate } from "@/lib/format";

const STANCE: Record<string, string> = { support: "Support", oppose: "Oppose", mixed: "Mixed" };

export default async function FormLettersPage() {
  const { ctx } = await requireCenter();
  const rows = await listFormLetters(ctx);
  return (
    <>
      <PageTitle title="Form letters" />
      {rows.length === 0 ? (
        <NoRows>No form letters yet.</NoRows>
      ) : (
        <div className="mt-8 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Letter</Th>
                <Th align="right">People</Th>
                <Th align="right">Wrote more</Th>
                <Th>Asks</Th>
                <Th>Last one</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Link href={`${ROOT}/form-letters/${r.id}`} className="text-base font-semibold text-ink transition-colors hover:text-ink-2">
                      {r.subject || "No subject"}
                    </Link>
                  </Td>
                  <Td align="right">{r.people}</Td>
                  <Td align="right">{r.withNotes}</Td>
                  <Td>{[r.stance ? STANCE[r.stance] : null, r.bill].filter(Boolean).join(" ") || "Not clear"}</Td>
                  <Td>{shortDate(r.lastSeenAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </>
  );
}
