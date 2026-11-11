"use server";

import { actAndRevalidate } from "../_lib/action";
import { addMember, resetMemberPassword, resetMemberTwoStep, setMemberRole, setMemberStatus } from "@/server/services/offices";
import type { RoleKey } from "@/server/authz/permissions";

export async function addMemberAction(input: { name: string; email: string; title: string; roleKey: string; password: string }) {
  return actAndRevalidate("/team", (ctx) => addMember(ctx,
    { name: input.name, email: input.email, title: input.title || undefined, roleKey: input.roleKey as RoleKey, password: input.password }),
  );
}

export async function memberRoleAction(userId: string, roleKey: string) {
  return actAndRevalidate("/team", (ctx) => setMemberRole(ctx, userId, roleKey as RoleKey));
}

export async function memberStatusAction(userId: string, status: "active" | "disabled") {
  return actAndRevalidate("/team", (ctx) => setMemberStatus(ctx, userId, status));
}

export async function memberPasswordAction(userId: string, temporaryPassword: string) {
  return actAndRevalidate("/team", (ctx) => resetMemberPassword(ctx, userId, temporaryPassword));
}

export async function memberTwoStepAction(userId: string) {
  return actAndRevalidate("/team", (ctx) => resetMemberTwoStep(ctx, userId));
}
