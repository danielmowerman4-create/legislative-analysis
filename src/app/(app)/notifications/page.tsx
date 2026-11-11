import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/server/auth/next";
import { listNotifications, markNotificationsRead } from "@/server/services/settings";
import { EmptyState, PageHeader } from "@/components/ui";
import { relative } from "@/lib/format";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const { ctx } = await requireOffice();
  const items = await listNotifications(ctx);
  // Load first, so what was unread still shows as unread on this visit.
  await markNotificationsRead(ctx);
  return (
    <>
      <PageHeader title="Notifications" meta={`${items.filter((n) => !n.readAt).length} unread`} />
      <div className="wrap py-8 lg:py-12">
        {items.length === 0 ? (
          <EmptyState title="No notifications." />
        ) : (
          <ul className="flex flex-col">
            {items.map((n) => (
              <li key={n.id} className="grid gap-x-8 gap-y-1 py-5 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  {!n.readAt && <span className="kicker block text-accent">Unread</span>}
                  {n.link ? (
                    <Link href={n.link} className="font-display text-md font-medium text-ink decoration-rule underline-offset-4 hover:underline">
                      {n.title}
                    </Link>
                  ) : (
                    <p className="font-display text-md font-medium text-ink">{n.title}</p>
                  )}
                  {n.body && <p className="mt-0.5 text-sm whitespace-pre-line text-ink-2">{n.body}</p>}
                </div>
                <span className="shrink-0 text-sm text-ink-3">{relative(n.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
