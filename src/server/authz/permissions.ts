export const PERMISSIONS = {
  "legislation.read": "View bills, votes, committees, legislators and the calendar", "legislation.track": "Track bills, set positions and add notes",
  "reports.read": "View and export bill reports", "integrations.manage": "Manage data sources and connected mailboxes",
  "team.manage": "Invite and manage staff", "settings.manage": "Change office settings", "audit.read": "View the audit log",
  "records.export": "Export office records", "inbox.read": "Open Constituent Center and read correspondence",
  "inbox.triage": "Assign, mark done and act on correspondence", "contacts.read": "View constituent records", "contacts.write": "Edit constituent records",
  "contacts.merge": "Merge constituent records", "cases.read": "View casework", "cases.write": "Open and work cases",
  "cases.read_sensitive": "Read sensitive correspondence and cases", "classification.review": "Review and correct how mail was read",
  "taxonomy.manage": "Manage the office's issue list", "tasks.write": "Create and complete tasks", "communications.draft": "Draft replies",
  "communications.approve": "Approve replies", "senders.manage": "Confirm senders and manage sender rules",
  "ledger.read": "View the record of every message received",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export type RoleKey = "owner" | "chief_of_staff" | "legislative_aide" | "caseworker" | "viewer";

export const ROLE_TEMPLATES: Record<RoleKey, { name: string; permissions: Permission[] }> = {
  owner: { name: "Owner", permissions: ALL_PERMISSIONS },
  chief_of_staff: { name: "Chief of Staff", permissions: ALL_PERMISSIONS.filter((p) => p !== "settings.manage" && p !== "records.export") },
  legislative_aide: {
    name: "Legislative Aide",
    permissions: [
      "legislation.read", "legislation.track", "reports.read", "inbox.read", "inbox.triage", "contacts.read", "contacts.write", "cases.read",
      "classification.review", "tasks.write", "communications.draft",
    ],
  },
  caseworker: {
    name: "Caseworker",
    permissions: [
      "legislation.read", "reports.read", "inbox.read", "inbox.triage", "contacts.read", "contacts.write", "contacts.merge", "cases.read", "cases.write",
      "cases.read_sensitive", "classification.review", "tasks.write", "communications.draft",
    ],
  },
  viewer: { name: "Viewer", permissions: ["legislation.read", "reports.read"] },
};
