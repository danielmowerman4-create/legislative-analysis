import { eq } from "drizzle-orm";
import { withTenant } from "@/server/db/client";
import { emailConnections, emailSyncState } from "@/server/db/schema";
import { encryptSecret } from "@/server/crypto";
import { setProviderFetchForTests } from "@/server/email/providers/http";
import { FakeGmail } from "./fake-gmail";

export async function connectFakeGmail(orgId: string, userId: string, address = "rep.test@house.example.gov", importFrom = "2026-01-01") {
  const gmail = new FakeGmail(address);
  setProviderFetchForTests(gmail.fetch);
  const [conn] = await withTenant({ orgId }, (tx) =>
    tx
      .insert(emailConnections)
      .values({
        organizationId: orgId,
        provider: "google",
        emailAddress: address,
        status: "active",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        accessTokenEnc: encryptSecret("fake-access"),
        refreshTokenEnc: encryptSecret("fake-refresh"),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        authorizedBy: userId,
        authorizedAt: new Date(),
        importFrom,
        selectedFolders: [{ id: "INBOX", name: "Inbox" }, { id: "SENT", name: "Sent" }],
      })
      .returning(),
  );
  await withTenant({ orgId },
    (tx) => tx.insert(emailSyncState).values({ organizationId: orgId, connectionId: conn.id, folderId: "*", cursorType: "gmail_history" }));
  return { gmail, conn };
}

export async function syncState(orgId: string, connectionId: string) {
  const [s] = await withTenant({ orgId }, (tx) => tx.select().from(emailSyncState).where(eq(emailSyncState.connectionId, connectionId)));
  return s;
}
