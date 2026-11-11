import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { freshDatabase, makeOffice } from "../helpers/db";
import { orNotFound } from "@/server/auth/next";
import { withTenant } from "@/server/db/client";
import { AppError, notFound } from "@/server/errors";
import { compareBillVersions, getBillDetail, getCommittee, getLegislator, listBills } from "@/server/services/legislation";
import type { OfficeContext } from "@/server/authz/context";

const ZERO = "00000000-0000-0000-0000-000000000000";
const isNotFound = expect.objectContaining({ code: "not_found" });

describe("a bad value in a link", () => {
  let ctx: OfficeContext;
  beforeAll(async () => {
    await freshDatabase();
    ctx = (await makeOffice()).ctx;
  });

  it("treats a record that does not exist as not found", async () => {
    await expect(getBillDetail(ctx, ZERO)).rejects.toEqual(isNotFound);
    await expect(getCommittee(ctx, ZERO)).rejects.toEqual(isNotFound);
    await expect(getLegislator(ctx, ZERO)).rejects.toEqual(isNotFound);
  });

  it("treats a malformed id as not found", async () => {
    await expect(getBillDetail(ctx, "not-a-uuid")).rejects.toEqual(isNotFound);
    await expect(getCommittee(ctx, "not-a-uuid")).rejects.toEqual(isNotFound);
    await expect(getLegislator(ctx, "not-a-uuid")).rejects.toEqual(isNotFound);
    await expect(compareBillVersions(ctx, ZERO, "not-a-uuid", "not-a-uuid")).rejects.toEqual(isNotFound);
  });

  it("treats junk in a list's filters as not found", async () => {
    await expect(listBills(ctx, { q: "\0" } as never)).rejects.toEqual(isNotFound);
    await expect(listBills(ctx, { committee: "notuuid" } as never)).rejects.toEqual(isNotFound);
    await expect(listBills(ctx, { session: "notuuid" } as never)).rejects.toEqual(isNotFound);
    await expect(listBills(ctx, { offset: 1e99 } as never)).rejects.toEqual(isNotFound);
  });

  it("still reports a real database failure as one", async () => {
    const failed = await withTenant({ orgId: ctx.orgId }, (tx) => tx.execute(sql`select * from no_such_table`)).catch((e) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(AppError);
  });

  it("shows the not-found page for not found, and only for that", async () => {
    await expect(orNotFound(Promise.resolve(7))).resolves.toBe(7);
    await expect(orNotFound(Promise.reject(notFound()))).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    const other = new AppError("forbidden", "No.");
    await expect(orNotFound(Promise.reject(other))).rejects.toBe(other);
  });
});
