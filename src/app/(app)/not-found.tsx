import type { Metadata } from "next";
import { NotFoundPage } from "@/components/not-found-page";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return <NotFoundPage />;
}
