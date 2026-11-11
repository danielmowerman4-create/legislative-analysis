import { cn } from "@/components/ui";

// The Capitol dome, drawn from the 1879 engraving of the building.
function BrandMark() {
  return (
    <svg aria-hidden viewBox="0 0 40 64" className="h-10 w-[25px] shrink-0 text-accent" fill="currentColor">
      <path d="M19.2 0h1.6v5h-1.6zM20 3.6l3.5 9.4h-7zM15.5 12.4l1.15 2 1.15-2 1.1 2 1.1-2 1.1 2 1.1-2 1.15 2 1.15-2V21h-9zM12.4 21.6h15.2v3.8H12.4zM13.6 26h12.8l-3.8 2.5h-5.2zM8.2 41.4C8.2 33 13.2 28.8 20 28.8S31.8 33 31.8 41.4zM6.3 42.2l.9-3.8.9 3.8zM31.9 42.2l.9-3.8.9 3.8zM6.6 42.4h26.8v1.8H6.6zM8 44.8h24v7H8zM6.8 52.4h26.4v1.5H6.8zM8 54.5h24v4.6H8zM4.6 59.7h30.8v1.6H4.6zM2.4 62h35.2v2H2.4z" />
      {/* Dome ribs, lantern slits and the drum's arched windows, cut out. */}
      <path d="M20 28.8v12.6M20 28.8C15.4 31.5 13.4 36 13.4 41.4M20 28.8C24.6 31.5 26.6 36 26.6 41.4M18 15.8V20.6M20 15.8V20.6M22 15.8V20.6" fill="none"
        stroke="var(--bg)" strokeWidth="1" />
      <path d="M10.4 51v-3.4q0-1.2 1.6-2.2 1.6 1 1.6 2.2V51zM18.4 51v-3.4q0-1.2 1.6-2.2 1.6 1 1.6 2.2V51zM26.4 51v-3.4q0-1.2 1.6-2.2 1.6 1 1.6 2.2V51zM10.6 55.6h2.8v2.6h-2.8zM18.6 55.6h2.8v2.6h-2.8zM26.6 55.6h2.8v2.6h-2.8z" fill="var(--bg)" />
    </svg>
  );
}

export function Wordmark({ className, compact }: { className?: string; compact?: boolean }) {
  // compact hides the name where the navigation is tight: phones and tablets.
  const room = compact ? "hidden sm:block md:hidden lg:block" : "";
  return (
    <span className={cn("flex items-center gap-2.5 sm:gap-3.5", className)}>
      <BrandMark />
      <span aria-hidden className={cn("h-8 w-px bg-line-strong", room)} />
      <span className={cn("font-display text-[18px] leading-none font-bold whitespace-nowrap text-ink sm:text-[23px]", room)}>Legislative Analysis</span>
    </span>
  );
}
