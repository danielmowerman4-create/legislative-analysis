import Link from "next/link";
import { ArrowRight, ChevronDown, type LucideIcon } from "lucide-react";
import { Children, cloneElement, isValidElement, useId, type ComponentProps, type ReactElement, type ReactNode } from "react";

export const cn = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger" | "brand" | "solid";
const variants: Record<Variant, string> = {
  primary: "bg-button text-on-button hover:bg-button-hover border border-transparent px-5",
  brand: "bg-button text-on-button hover:bg-button-hover border border-transparent px-5",
  solid: "bg-accent text-accent-contrast hover:bg-accent-strong border border-transparent px-5",
  secondary: "text-ink border border-line-strong hover:border-ink px-5",
  ghost: "text-ink hover:text-ink-2 border border-transparent",
  danger: "text-danger border border-transparent hover:underline underline-offset-4",
};
const base = "inline-flex items-center justify-center gap-2 h-10 text-sm font-semibold whitespace-nowrap select-none disabled:opacity-50 disabled:pointer-events-none transition-[color,background-color,border-color,transform] duration-150 active:translate-y-px";

export function Button({ variant = "secondary", className, ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={cn(base, variants[variant], className)} {...props} />;
}

export function LinkButton({ variant = "secondary", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={cn(base, variants[variant], className)} {...props} />;
}

type ActionLinkProps = { href: string; plain?: boolean; className?: string; children: ReactNode; icon?: LucideIcon };

export function ActionLink({ href, plain, className, children, icon: Icon = ArrowRight }: ActionLinkProps) {
  const style = cn("kicker group inline-flex items-center gap-2 whitespace-nowrap text-ink transition-colors duration-150 hover:text-ink-2", className);
  const inner = (
    <>
      {children}
      <Icon aria-hidden className="size-4 text-rule transition-transform duration-200 ease-out-quart group-hover:translate-x-0.5" strokeWidth={2} />
    </>
  );
  return plain ? (
    <a href={href} className={style}>{inner}</a>
  ) : (
    <Link href={href} className={style}>{inner}</Link>
  );
}

export function Sep({ className }: { className?: string }) {
  return <span aria-hidden className={cn("mx-2.5 font-normal text-line-strong", className)}>|</span>;
}

export function SepList({ children, className, center }: { children: ReactNode; className?: string; center?: boolean }) {
  if (center) {
    return (
      <ul className={cn("flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-center", className)}>
        {Children.toArray(children).map((c, i) => (
          <li key={i} className="leading-[1.15] [text-wrap:balance]">{c}</li>
        ))}
      </ul>
    );
  }
  // The negative margin hides the rule that would open a wrapped line.
  return (
    <div className={cn("overflow-hidden", className)}>
      <ul className="-ml-[21px] flex flex-wrap items-center gap-y-1">
        {Children.toArray(children).map((c, i) => (
          <li key={i} className="ml-2.5 border-l border-line-strong pl-2.5 leading-[1.15]">{c}</li>
        ))}
      </ul>
    </div>
  );
}

const field =
  "h-10 border-0 border-b border-line-strong bg-transparent px-0 text-sm text-ink placeholder:text-ink-3 transition-[border-color,box-shadow] duration-150 hover:border-ink focus:border-ink focus:shadow-[0_1px_0_0_var(--text)] focus:outline-none disabled:text-ink-3";

// Width classes go on the wrapper; everything else on the control.
const WIDTH = /^(w-|flex-|min-w-|max-w-|basis-)/;
const split = (className?: string) => {
  const parts = (className ?? "").split(/\s+/).filter(Boolean);
  const width = parts.filter((p) => WIDTH.test(p.replace(/^[a-z]+:/, "")));
  return { width: width.length ? width.join(" ") : "w-full", rest: parts.filter((p) => !width.includes(p)).join(" ") };
};

const solidField = "h-14 border-b-2 border-ink bg-transparent px-4 text-md text-ink placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-2 focus:outline-rule";

export function Input({ className, solid, ...props }: ComponentProps<"input"> & { solid?: boolean }) {
  const { width, rest } = split(className);
  return <input className={cn(solid ? solidField : field, width, rest)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  const { width, rest } = split(className);
  return (
    <span className={cn("relative inline-flex", width)}>
      <select className={cn(field, "w-full cursor-pointer appearance-none truncate pr-6", rest)} {...props} />
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-0 size-4 -translate-y-1/2 text-ink-3" strokeWidth={1.75} />
    </span>
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  const { width, rest } = split(className);
  return <textarea className={cn(field, width, "h-auto py-2 leading-6", rest)} {...props} />;
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  // A lone control without an id gets one, so its label names it for screen readers.
  const made = useId();
  const only = !htmlFor && isValidElement(children) ? (children as ReactElement<{ id?: string }>) : null;
  const id = htmlFor ?? only?.props.id ?? (only ? made : undefined);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold text-ink">{label}</label>
      {only && !only.props.id ? cloneElement(only, { id }) : children}
      {hint && <p className="text-sm text-ink-3">{hint}</p>}
    </div>
  );
}

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";
const toneText: Record<Tone, string> = { neutral: "text-ink-2", accent: "text-accent", ok: "text-ok", warn: "text-warn-ink", danger: "text-danger" };

export function Status({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("text-sm font-semibold whitespace-nowrap", toneText[tone], className)}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-6 min-w-6 items-center justify-center border-b border-line-strong px-1 font-sans text-xs text-ink-3">{children}</kbd>;
}

// The Connecticut State Capitol in daylight (Carol M. Highsmith Archive, Library of Congress, no known restrictions).
export function Landmark({ className, lazy }: { className?: string; lazy?: boolean }) {
  // The not-found page ships with every page; lazy keeps its photos from loading.
  const loading = lazy ? "lazy" : undefined;
  return (
    <div aria-hidden className={cn("landmark", className)}>
      <div className="landmark-sky">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="landmark-photo" loading={loading} src="/art/capitol-2000.webp"
          srcSet="/art/capitol-1200.webp 1200w, /art/capitol-2000.webp 2000w, /art/capitol-3072.webp 3072w" sizes="max(107vw, 1100px)" alt="" />
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="landmark-top" loading={loading} src="/art/capitol-top.webp" alt="" />
    </div>
  );
}

const anchorSize = (title: ReactNode) => {
  const length = typeof title === "string" ? title.length : 12;
  return length > 44 ? "text-[42px] lg:text-[62px]" : length > 24 ? "text-[52px] lg:text-[76px]" : "text-[64px] lg:text-[92px]";
};

type PageHeaderProps = { title: ReactNode; meta?: ReactNode; actions?: ReactNode; children?: ReactNode; crumbs?: ReactNode; compact?: boolean };

export function PageHeader({ title, meta, actions, children, crumbs, compact }: PageHeaderProps) {
  const size = compact ? "display mt-1 max-w-[60ch] text-[26px] lg:text-[32px]" : cn("anchor uppercase", anchorSize(title));
  return (
    <header>
      <div className="wrap relative z-10">
        {crumbs && <div className="pt-5">{crumbs}</div>}
        <div className={cn("pb-5 text-center", crumbs ? "pt-1" : "pt-6 lg:pt-8")}>
          {compact && meta && <div className="anchor text-[52px] text-ink uppercase lg:text-[72px]">{meta}</div>}
          <h1 className={cn("mx-auto min-w-0 text-ink [text-wrap:balance]", size)}>{title}</h1>
          {!compact && meta && <div className="mt-2 text-md text-ink-2">{meta}</div>}
          {actions && <div className="mt-3 flex flex-wrap items-center justify-center gap-x-7 gap-y-2">{actions}</div>}
        </div>
        {children}
      </div>
    </header>
  );
}

export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center text-sm text-ink-3">
      {items.map((c, i) => (
        <span key={c.label} className="flex items-center">
          {i > 0 && <Sep />}
          {c.href ? (
            <Link href={c.href} className="transition-colors hover:text-ink">{c.label}</Link>
          ) : (
            <span className="text-ink-2">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function EmptyState({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-4 py-16">
      <p className="display text-xl font-medium text-ink">{title}</p>
      {children && <div className="max-w-prose text-sm text-ink-2">{children}</div>}
      {action}
    </div>
  );
}

export function Notice({ tone = "warn", title, children }: { tone?: Tone; title: string; children?: ReactNode }) {
  return (
    <div role="status" className="border-y border-line py-4">
      <p className={cn("text-sm font-semibold", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn-ink" : "text-ink")}>{title}</p>
      {children && <div className="mt-0.5 text-sm text-ink-2">{children}</div>}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <table className={cn("w-full border-collapse text-sm", className)}>{children}</table>;
}

export function Th({ children, className, align = "left", ...rest }: ComponentProps<"th"> & { align?: "left" | "right" }) {
  return (
    <th scope="col" className={cn("kicker border-b border-line-strong px-3 pb-2.5 align-bottom whitespace-nowrap text-ink-2 first:pl-0 last:pr-0",
      align === "right" ? "text-right" : "text-left", className)} {...rest}>
      {children}
    </th>
  );
}

export function Td({ children, className, align = "left", ...rest }: ComponentProps<"td"> & { align?: "left" | "right" }) {
  return (
    <td className={cn("border-b border-line px-3 py-4 align-middle first:pl-0 last:pr-0", align === "right" && "text-right tabular", className)} {...rest}>
      {children}
    </td>
  );
}
