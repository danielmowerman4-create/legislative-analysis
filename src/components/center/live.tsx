"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/components/ui";
import { waited } from "@/lib/format";

export function Marked({ children }: { children: string }) {
  const ref = useRef<HTMLElement>(null);
  const [split, setSplit] = useState<{ text: string; lines: string[] } | null>(null);
  const [seen, setSeen] = useState(false);
  const lines = split?.text === children ? split.lines : null;

  useEffect(() => {
    const el = ref.current;
    if (!el || lines) return;
    let live = true;
    // Line breaks are final only once the web font has loaded.
    document.fonts.ready.then(() => {
      const node = el.firstChild;
      if (!live || !node || node.nodeType !== Node.TEXT_NODE) return;
      // On a slow load the CSS fallback has already marked these words; keep it.
      if (el.getAnimations().some((a) => a.playState === "finished")) return;
      const range = document.createRange();
      const out: string[] = [];
      let start = 0;
      let top: number | null = null;
      for (const m of children.matchAll(/\S+\s*/g)) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + 1);
        const r = range.getClientRects()[0];
        if (!r) continue;
        if (top !== null && r.top > top + r.height / 2) {
          out.push(children.slice(start, m.index));
          start = m.index;
        }
        top = r.top;
      }
      out.push(children.slice(start));
      setSplit({ text: children, lines: out });
    });
    return () => {
      live = false;
    };
  }, [children, lines]);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  return (
    <mark ref={ref} className={cn("hl", !lines && "hl-wait")} data-on={seen || undefined}>
      {lines
        ? lines.map((line, i) => (
            <span key={i} className="hl-line" style={{ "--i": i } as CSSProperties}>{line}</span>
          ))
        : children}
    </mark>
  );
}

export function DoneStamp({ done }: { done: boolean }) {
  const [was, setWas] = useState(done);
  const [fresh, setFresh] = useState(false);
  if (was !== done) {
    setWas(done);
    setFresh(done);
  }
  return done ? <span className={cn("stamp stamp-large text-support", fresh && "stamp-land")}>Done</span> : null;
}

export function Waiting({ since, initial }: { since: string; initial: string }) {
  const [label, setLabel] = useState(initial);
  useEffect(() => {
    const tick = () => setLabel(waited(since));
    const soon = setTimeout(tick, 1_000);
    const id = setInterval(tick, 30_000);
    return () => {
      clearTimeout(soon);
      clearInterval(id);
    };
  }, [since]);
  return <span>Waiting {label}</span>;
}
