import type { Metadata } from "next";
import { requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { listTeam } from "@/server/services/offices";
import { ROLE_TEMPLATES, PERMISSIONS } from "@/server/authz/permissions";
import { PageHeader, Table, Td, Th } from "@/components/ui";
import { Section } from "@/components/ui/blocks";
import { relative } from "@/lib/format";
import { AddMemberForm, MemberControls, MemberRecovery } from "./team-controls";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const { ctx } = await requireOffice();
  const team = await listTeam(ctx);
  const canManage = can(ctx, "team.manage");
  const roles = Object.entries(ROLE_TEMPLATES).map(([k, v]) => ({ key: k, name: v.name }));
  return (
    <>
      <PageHeader title="Team" meta={`${team.length} staff`} />
      <div className="wrap">
        <div>
          <Section title="Staff">
            <div className="overflow-x-auto">
            <Table className={canManage ? "min-w-[880px]" : "min-w-[680px]"}>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Role</Th>
                  <Th>Two-step</Th>
                  <Th>Last sign-in</Th>
                  <Th>Status</Th>
                  {canManage && <Th>Locked out</Th>}
                </tr>
              </thead>
              <tbody>
                {team.map((m) => (
                  <tr key={m.userId}>
                    <Td>
                      <span className="block font-display text-md font-medium text-ink">{m.name}</span>
                      <span className="block text-sm text-ink-2">{[m.title, m.email].filter(Boolean).join(" · ")}</span>
                    </Td>
                    <Td>
                      {canManage && m.userId !== ctx.userId ? (
                        <MemberControls userId={m.userId} roleKey={m.roleKey} status={m.status} roles={roles} />
                      ) : m.roleName}
                    </Td>
                    <Td className={m.mfaEnabledAt ? "text-ok" : "text-warn-ink"}>{m.mfaEnabledAt ? "On" : "Off"}</Td>
                    <Td className="text-ink-3">{relative(m.lastLoginAt)}</Td>
                    <Td className={m.status === "active" ? "text-ink-2" : "text-ink-3"}>{m.status === "active" ? "Active" : "Disabled"}</Td>
                    {canManage && (
                      <Td>{m.userId !== ctx.userId ? <MemberRecovery userId={m.userId} name={m.name} twoStepOn={Boolean(m.mfaEnabledAt)} /> : null}</Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
            </div>
          </Section>
          {canManage && (
            <Section title="Add staff member"><AddMemberForm roles={roles} /></Section>
          )}
          <Section title="What each role can do">
            <div className="overflow-x-auto">
              <Table className="min-w-[640px]">
                <thead>
                  <tr>
                    <Th>Permission</Th>
                    {roles.map((r) => (
                      <Th key={r.key} className="text-center">{r.name}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(PERMISSIONS).map(([p, desc]) => (
                    <tr key={p}>
                      <Td>{desc}</Td>
                      {roles.map((r) => (
                        <Td key={r.key} className="text-center">
                          {ROLE_TEMPLATES[r.key as keyof typeof ROLE_TEMPLATES].permissions.includes(p as keyof typeof PERMISSIONS) ? (
                            <span aria-label="Allowed">✓</span>
                          ) : (
                            <span className="text-ink-3" aria-label="Not allowed">–</span>
                          )}
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
