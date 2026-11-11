"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, ViewTransition, type ReactNode } from "react";

export const prefersCalm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Tick({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    const up = value > last.current;
    last.current = value;
    if (prefersCalm()) return;
    ref.current?.animate([{ transform: `translateY(${up ? "40%" : "-40%"})`, opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 200, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  }, [value]);
  return <span ref={ref} className="tabular inline-block">{value}</span>;
}

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <ViewTransition key={pathname} enter="page-in" exit="page-out" default="none">
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </ViewTransition>
  );
}
