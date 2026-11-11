import "server-only";
import { notFound } from "next/navigation";
import { can } from "../authz/context";
import { centerEnabled } from "../services/center";
import { requireOffice } from "./next";

export async function requireCenter() {
  const s = await requireOffice();
  if (!can(s.ctx, "inbox.read") || !(await centerEnabled(s.org.id))) notFound();
  return s;
}
