import { ActionLink, Landmark, PageHeader } from "@/components/ui";
import { BillSearch } from "@/components/bill-search";

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Not found" meta="That link is old or mistyped." actions={
        <>
          <ActionLink href="/today">Today</ActionLink>
          <ActionLink href="/bills">All bills</ActionLink>
        </>
      }>
        <BillSearch className="mx-auto mb-4 max-w-[620px]" />
      </PageHeader>
      <Landmark lazy className="landmark-clear" />
    </>
  );
}
