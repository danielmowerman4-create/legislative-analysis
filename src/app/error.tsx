"use client";

import { ActionLink, Button, PageHeader } from "@/components/ui";

export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="pt-10">
      <PageHeader title="Something went wrong" meta="This page did not load." actions={
        <>
          <Button type="button" variant="solid" onClick={() => retry()}>Try again</Button>
          <ActionLink href="/today">Today</ActionLink>
        </>
      } />
    </div>
  );
}
