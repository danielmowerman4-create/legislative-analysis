import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function CenterDoor({ needsPerson, newMail }: { needsPerson: number; newMail: number }) {
  return (
    <Link href="/constituent-center" className="band band-forest no-print group block transition-colors hover:bg-forest-deep">
      <div className="wrap flex flex-wrap items-center justify-center gap-x-10 gap-y-2 py-6 text-center">
        <span className="rail-title text-[44px] sm:text-[56px]">Constituent Center</span>
        <span className="flex items-center gap-5 text-lg sm:text-xl">
          {needsPerson > 0 && (
            <span className="tabular font-semibold">{needsPerson} {needsPerson === 1 ? "needs" : "need"} a person</span>
          )}
          {newMail > 0 && <span className="tabular">{newMail} new</span>}
          <ArrowRight aria-hidden className="size-6 transition-transform duration-150 group-hover:translate-x-1" strokeWidth={1.75} />
        </span>
      </div>
    </Link>
  );
}
