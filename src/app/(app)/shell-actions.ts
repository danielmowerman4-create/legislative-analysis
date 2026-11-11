"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sessionToken } from "@/server/auth/next";
import { switchOffice } from "@/server/auth/sessions";

export async function switchOfficeAction(orgId: string) {
  const token = await sessionToken();
  if (!token) redirect("/login");
  await switchOffice(token, orgId);
  revalidatePath("/", "layout");
  redirect("/today");
}
