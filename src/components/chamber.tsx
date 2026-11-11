"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { seatLayout, seatOrder, stableHash, type ChamberMark, type ChamberSeat } from "@/lib/chamber";
import { cn } from "@/components/ui";
import { prefersCalm, Tick } from "@/components/motion";

// Rolls already played this visit start filled.
const called = new Set<string>();

type Stage = "waiting" | "running" | "done";

function Count({ value, stage, delays }: { value: number; stage: Stage; delays: number[] }) {
  const [running, setRunning] = useState(0);
  useEffect(() => {
    if (stage !== "running") return;
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      setRunning(delays.filter((d) => d <= now - start).length);
      if (now - start < delays[delays.length - 1]) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [stage, delays]);
  return stage === "running" ? <span className="tabular inline-block">{running}</span> : <Tick value={value} />;
}

type ChamberProps = { seats: ChamberSeat[]; label: string; playKey: string; value: number; valueLabel: string; officeId?: string | null; selectedId?: string |
  null; only?: ReadonlySet<string> | null; onPick?: (id: string) => void; onHover?: (id: string | null) => void; replay?: number; className?: string };

export function Chamber({ seats, label, playKey, value, valueLabel, officeId, selectedId, only, onPick, onHover, replay = 0, className }: ChamberProps) {
  const ordered = useMemo(() => seatOrder(seats), [seats]);
  const layout = useMemo(() => seatLayout(seats.length), [seats.length]);
  const root = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>(() => (called.has(playKey) ? "done" : "waiting"));
  const [hover, setHover] = useState(-1);

  const duration = 900 + seats.length * 2;
  const delays = useMemo(() => {
    const rollCall = [...seats].sort((a, b) => stableHash(a.name) - stableHash(b.name));
    return new Map(rollCall.map((s, i) => [s.id, Math.round((i / Math.max(seats.length, 1)) * duration)]));
  }, [seats, duration]);
  const countedDelays = useMemo(() => seats.filter((s) => s.mark === "yes" || s.mark === "lean_yes").map((s) => delays.get(s.id) ?? 0).sort((a, b) => a - b),
    [seats, delays]);

  useEffect(() => {
    if (stage !== "waiting") return;
    const el = root.current;
    if (!el) return;
    const begin = () => {
      called.add(playKey);
      setStage(prefersCalm() ? "done" : "running");
    };
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        seen.disconnect();
        begin();
      },
      { threshold: 0.25 },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [stage, playKey]);

  useEffect(() => {
    if (stage !== "running") return;
    const finish = window.setTimeout(() => setStage("done"), duration + 260);
    return () => window.clearTimeout(finish);
  }, [stage, duration]);

  const lastReplay = useRef(replay);
  useEffect(() => {
    if (lastReplay.current === replay) return;
    lastReplay.current = replay;
    setStage("waiting");
  }, [replay]);

  const nearest = (e: PointerEvent<SVGSVGElement>) => {
    const matrix = e.currentTarget.getScreenCTM();
    if (!matrix) return -1;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    const reach = (layout.seat * (e.pointerType === "touch" ? 3.4 : 2.2)) ** 2;
    let best = -1;
    let bestAt = reach;
    layout.points.forEach((q, i) => {
      const at = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (at <= bestAt) {
        bestAt = at;
        best = i;
      }
    });
    return best;
  };
  const point = (e: PointerEvent<SVGSVGElement>) => {
    const i = e.pointerType === "mouse" ? nearest(e) : -1;
    if (i === hover) return;
    setHover(i);
    onHover?.(i >= 0 ? ordered[i].id : null);
  };

  const seatMarks = useMemo(
    () =>
      ordered.map((s, i) => (
        <circle key={s.id} className="seat" data-m={s.mark} data-dim={only && !only.has(s.id) ? "" : undefined} cx={layout.points[i].x} cy={layout.points[i].y}
          r={layout.seat} style={{ "--d": `${delays.get(s.id) ?? 0}ms` } as CSSProperties} />
      )),
    [ordered, layout, delays, only],
  );

  const ring = (i: number, cls: string) => i >= 0 && <circle className={cls} cx={layout.points[i].x} cy={layout.points[i].y} r={layout.seat + 3.5} />;
  const officeAt = officeId ? ordered.findIndex((s) => s.id === officeId) : -1;
  const selectedAt = selectedId ? ordered.findIndex((s) => s.id === selectedId) : -1;
  const democrats = ordered.filter((s) => (s.party ?? "").toUpperCase().startsWith("D")).length;
  const republicans = ordered.filter((s) => (s.party ?? "").toUpperCase().startsWith("R")).length;

  return (
    <div ref={root} className={cn("chamber", className)} data-stage={stage}>
      <div className="relative">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={label}
          className={cn("block w-full touch-manipulation", onPick && "cursor-pointer")}
          style={{ "--r": `${layout.seat}px` } as CSSProperties}
          onPointerMove={point}
          onPointerLeave={() => {
            setHover(-1);
            onHover?.(null);
          }}
          onClick={(e) => {
            const i = nearest(e as unknown as PointerEvent<SVGSVGElement>);
            if (i >= 0) onPick?.(ordered[i].id);
          }}
        >
          {seatMarks}
          {ring(officeAt, "seat-ring")}
          {ring(selectedAt, "seat-focus")}
          {hover !== selectedAt && ring(hover, "seat-focus")}
        </svg>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center">
          <span className="chamber-count display text-[34px] leading-[38px] text-ink sm:text-[52px] sm:leading-[56px]">
            <Count value={value} stage={stage} delays={countedDelays} />
          </span>
          <span className="text-sm text-ink-2">{valueLabel}</span>
        </div>
      </div>
      {democrats > 0 && republicans > 0 && (
        <p className="mt-2 flex justify-between text-sm text-ink-3">
          <span className="tabular">Democrats {democrats}</span>
          <span className="tabular">Republicans {republicans}</span>
        </p>
      )}
    </div>
  );
}

export function SeatKey({ mark, children }: { mark: ChamberMark; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg aria-hidden viewBox="-13 -13 26 26" className="size-4 shrink-0"><circle className="seat" data-m={mark} r="10" /></svg>
      {children}
    </span>
  );
}

const SAID: Partial<Record<ChamberMark, string>> = { yes: "voted yes", no: "voted no", not_voting: "did not vote" };

type VoteChamberProps = { id: string; seats: ChamberSeat[]; value: number; officeId?: string | null; open: boolean };

export function VoteChamber({ id, seats, value, officeId, open: startOpen }: VoteChamberProps) {
  const [open, setOpen] = useState(startOpen);
  const [replay, setReplay] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink-2">
        See the chamber
      </button>
    );
  }
  const shown = seats.find((s) => s.id === (hover ?? picked ?? officeId));
  const counts = (m: ChamberMark) => seats.filter((s) => s.mark === m).length;
  return (
    <div>
      <Chamber
        seats={seats}
        playKey={id}
        value={value}
        valueLabel="yes"
        officeId={officeId}
        selectedId={picked}
        replay={replay}
        onHover={setHover}
        onPick={setPicked}
        label={`${counts("yes")} yes, ${counts("no")} no, ${counts("not_voting")} not voting. Each member is listed under How each member voted.`}
      />
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-2">
        <SeatKey mark="yes">Yes</SeatKey>
        <SeatKey mark="no">No</SeatKey>
        <SeatKey mark="not_voting">Not voting</SeatKey>
        <button type="button" onClick={() => setReplay((n) => n + 1)}
          className="ml-auto text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink-2">
          Call the roll again
        </button>
      </div>
      <p className="mt-1 min-h-6 text-sm text-ink">
        {shown && (
          <Link href={`/legislators/${shown.id}`} className="underline decoration-rule underline-offset-4">
            {shown.name}, {[(shown.party ?? "").slice(0, 1).toUpperCase(), shown.district].filter(Boolean).join("-")}, {SAID[shown.mark]}
          </Link>
        )}
      </p>
    </div>
  );
}
