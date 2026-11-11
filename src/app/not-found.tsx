import type { Metadata } from "next";
import { Wordmark } from "@/components/shell/brand";
import { NotFoundPage } from "@/components/not-found-page";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <>
      <div className="wrap pt-6"><Wordmark /></div>
      <NotFoundPage />
    </>
  );
}
