"use client";

import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

export function FilterForm({ action, ...props }: Omit<ComponentProps<"form">, "action"> & { action: string }) {
  const router = useRouter();
  return (
    <form
      {...props}
      action={action}
      onSubmit={(e) => {
        e.preventDefault();
        const params = new URLSearchParams();
        new FormData(e.currentTarget).forEach((v, k) => {
          if (typeof v === "string" && v) params.append(k, v);
        });
        const qs = params.toString();
        router.push(qs ? `${action}?${qs}` : action, { scroll: false, transitionTypes: ["list"] });
      }}
      onChange={(e) => {
        if ((e.target as HTMLElement).tagName === "SELECT") e.currentTarget.requestSubmit();
      }}
    />
  );
}
