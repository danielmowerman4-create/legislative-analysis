import { Wordmark } from "@/components/shell/brand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="band relative flex min-h-64 flex-col overflow-hidden px-8 py-8 lg:min-h-0 lg:px-14 lg:py-12">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img aria-hidden src="/art/capitol-2000.webp" srcSet="/art/capitol-1200.webp 1200w, /art/capitol-2000.webp 2000w, /art/capitol-3072.webp 3072w"
          sizes="(min-width: 1024px) 110vw, 200vw" alt="" className="absolute inset-0 size-full object-cover object-[53%_0%]" />
        <Wordmark className="relative" />
      </div>
      <div className="flex items-center justify-center px-6 py-14"><div className="w-full max-w-[400px]">{children}</div></div>
    </main>
  );
}
