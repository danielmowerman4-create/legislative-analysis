"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui";

export function PrintButton() {
  return (
    <Button type="button" variant="solid" onClick={() => window.print()}><Printer className="size-4" strokeWidth={1.75} />Print or save as PDF</Button>
  );
}
