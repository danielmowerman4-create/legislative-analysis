import type { CSSProperties } from "react";
import { stableHash } from "@/lib/chamber";
import { cn } from "@/components/ui";
import type { BillPosition } from "@/server/db/schema";

const INK: Record<BillPosition, { word: string; tone: string }> = {
  support: { word: "Support", tone: "text-support" },
  oppose: { word: "Oppose", tone: "text-oppose" },
  neutral: { word: "Neutral", tone: "text-neutral" },
  watching: { word: "Watch", tone: "text-ink-2" },
};

type PositionStampProps = { position: BillPosition; seed: string; fresh?: boolean; large?: boolean; decorative?: boolean; className?: string };

export function PositionStamp({ position, seed, fresh, large, decorative, className }: PositionStampProps) {
  const tilt = -7 + (stableHash(seed) % 5);
  const ink = INK[position];
  return (
    <span aria-hidden={decorative || undefined} className={cn("stamp", ink.tone, large && "stamp-large", fresh && "stamp-land", className)}
      style={{ "--tilt": `${tilt}deg` } as CSSProperties}>
      {ink.word}
    </span>
  );
}
