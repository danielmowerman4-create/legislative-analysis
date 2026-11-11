CREATE TABLE "mail_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid,
	"source_key" text NOT NULL,
	"provider_message_id" text,
	"from_address" text,
	"subject" text,
	"received_at" timestamp with time zone,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"message_id" uuid,
	"rule_id" uuid,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"restored_by" uuid,
	"restored_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"mailbox_count" integer NOT NULL,
	"ledger_count" integer NOT NULL,
	"repaired" integer DEFAULT 0 NOT NULL,
	"still_missing" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_asks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"quote" text NOT NULL,
	"quote_start" integer NOT NULL,
	"quote_end" integer NOT NULL,
	"source" text NOT NULL,
	"urgency" text DEFAULT 'routine' NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"case_id" uuid,
	"handled_by" uuid,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sender_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"match_type" text NOT NULL,
	"value" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"reason" text,
	"proposed_by" text DEFAULT 'staff' NOT NULL,
	"created_by" uuid,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "office_settings" ADD COLUMN "center_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "office_settings" ADD COLUMN "center_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "office_settings" ADD COLUMN "ai_daily_limit" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_connections" ADD COLUMN "auth_mode" text DEFAULT 'delegated' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_connections" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "sender_trust" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "sender_trust_detail" jsonb DEFAULT '{"spf":null,"dkim":null,"dmarc":null,"reasons":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "claimed_address" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "claimed_name" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "personal_note" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "urgency_reason" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "template_clusters" ADD COLUMN "canonical_shingles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "template_clusters" ADD COLUMN "sketch" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_ledger" ADD CONSTRAINT "mail_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_ledger" ADD CONSTRAINT "mail_ledger_connection_id_email_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."email_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_ledger" ADD CONSTRAINT "mail_ledger_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_ledger" ADD CONSTRAINT "mail_ledger_restored_by_users_id_fk" FOREIGN KEY ("restored_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_reconciliations" ADD CONSTRAINT "mail_reconciliations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_reconciliations" ADD CONSTRAINT "mail_reconciliations_connection_id_email_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."email_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_asks" ADD CONSTRAINT "message_asks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_asks" ADD CONSTRAINT "message_asks_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_asks" ADD CONSTRAINT "message_asks_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_rules" ADD CONSTRAINT "sender_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_rules" ADD CONSTRAINT "sender_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_rules" ADD CONSTRAINT "sender_rules_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_ledger_source_uq" ON "mail_ledger" USING btree ("organization_id","source_key");--> statement-breakpoint
CREATE INDEX "mail_ledger_org_disposition_idx" ON "mail_ledger" USING btree ("organization_id","disposition");--> statement-breakpoint
CREATE INDEX "mail_ledger_org_created_idx" ON "mail_ledger" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_reconciliations_org_idx" ON "mail_reconciliations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "message_asks_org_status_idx" ON "message_asks" USING btree ("organization_id","status","urgency");--> statement-breakpoint
CREATE INDEX "message_asks_message_idx" ON "message_asks" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sender_rules_uq" ON "sender_rules" USING btree ("organization_id","kind","match_type","value");--> statement-breakpoint
CREATE INDEX "sender_rules_org_status_idx" ON "sender_rules" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "template_clusters_sketch_idx" ON "template_clusters" USING gin ("sketch");
--> statement-breakpoint
-- Tenant isolation for the new tables. The ledger and reconciliations can be added to but never deleted by the application role.
ALTER TABLE "mail_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mail_ledger" TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "mail_ledger" TO li_app;--> statement-breakpoint
ALTER TABLE "mail_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mail_reconciliations" TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());--> statement-breakpoint
GRANT SELECT, INSERT ON "mail_reconciliations" TO li_app;--> statement-breakpoint
ALTER TABLE "sender_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "sender_rules" TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "sender_rules" TO li_app;--> statement-breakpoint
ALTER TABLE "message_asks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "message_asks" TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "message_asks" TO li_app;--> statement-breakpoint
-- Constituent Center permissions. Rows left over from before the product went bills-only are cleared first, so a role has exactly what its template says.
INSERT INTO permissions (key, description) VALUES
  ('integrations.manage', 'Manage data sources and connected mailboxes'),
  ('inbox.read', 'Open Constituent Center and read correspondence'),
  ('inbox.triage', 'Assign, mark done and act on correspondence'),
  ('contacts.read', 'View constituent records'),
  ('contacts.write', 'Edit constituent records'),
  ('contacts.merge', 'Merge constituent records'),
  ('cases.read', 'View casework'),
  ('cases.write', 'Open and work cases'),
  ('cases.read_sensitive', 'Read sensitive correspondence and cases'),
  ('classification.review', 'Review and correct how mail was read'),
  ('taxonomy.manage', 'Manage the office''s issue list'),
  ('tasks.write', 'Create and complete tasks'),
  ('communications.draft', 'Draft replies'),
  ('communications.approve', 'Approve replies'),
  ('senders.manage', 'Confirm senders and manage sender rules'),
  ('ledger.read', 'View the record of every message received')
ON CONFLICT (key) DO UPDATE SET description = excluded.description;--> statement-breakpoint
INSERT INTO roles (organization_id, key, name) SELECT DISTINCT organization_id, 'caseworker', 'Caseworker' FROM roles ON CONFLICT (organization_id, key) DO NOTHING;--> statement-breakpoint
DELETE FROM role_permissions rp USING roles r
  WHERE rp.role_id = r.id AND r.key IN ('owner', 'chief_of_staff', 'legislative_aide', 'caseworker', 'viewer')
  AND NOT EXISTS (SELECT 1 FROM (VALUES
  ('owner', 'legislation.read'),
  ('owner', 'legislation.track'),
  ('owner', 'reports.read'),
  ('owner', 'integrations.manage'),
  ('owner', 'team.manage'),
  ('owner', 'settings.manage'),
  ('owner', 'audit.read'),
  ('owner', 'records.export'),
  ('owner', 'inbox.read'),
  ('owner', 'inbox.triage'),
  ('owner', 'contacts.read'),
  ('owner', 'contacts.write'),
  ('owner', 'contacts.merge'),
  ('owner', 'cases.read'),
  ('owner', 'cases.write'),
  ('owner', 'cases.read_sensitive'),
  ('owner', 'classification.review'),
  ('owner', 'taxonomy.manage'),
  ('owner', 'tasks.write'),
  ('owner', 'communications.draft'),
  ('owner', 'communications.approve'),
  ('owner', 'senders.manage'),
  ('owner', 'ledger.read'),
  ('chief_of_staff', 'legislation.read'),
  ('chief_of_staff', 'legislation.track'),
  ('chief_of_staff', 'reports.read'),
  ('chief_of_staff', 'integrations.manage'),
  ('chief_of_staff', 'team.manage'),
  ('chief_of_staff', 'audit.read'),
  ('chief_of_staff', 'inbox.read'),
  ('chief_of_staff', 'inbox.triage'),
  ('chief_of_staff', 'contacts.read'),
  ('chief_of_staff', 'contacts.write'),
  ('chief_of_staff', 'contacts.merge'),
  ('chief_of_staff', 'cases.read'),
  ('chief_of_staff', 'cases.write'),
  ('chief_of_staff', 'cases.read_sensitive'),
  ('chief_of_staff', 'classification.review'),
  ('chief_of_staff', 'taxonomy.manage'),
  ('chief_of_staff', 'tasks.write'),
  ('chief_of_staff', 'communications.draft'),
  ('chief_of_staff', 'communications.approve'),
  ('chief_of_staff', 'senders.manage'),
  ('chief_of_staff', 'ledger.read'),
  ('legislative_aide', 'legislation.read'),
  ('legislative_aide', 'legislation.track'),
  ('legislative_aide', 'reports.read'),
  ('legislative_aide', 'inbox.read'),
  ('legislative_aide', 'inbox.triage'),
  ('legislative_aide', 'contacts.read'),
  ('legislative_aide', 'contacts.write'),
  ('legislative_aide', 'cases.read'),
  ('legislative_aide', 'classification.review'),
  ('legislative_aide', 'tasks.write'),
  ('legislative_aide', 'communications.draft'),
  ('caseworker', 'legislation.read'),
  ('caseworker', 'reports.read'),
  ('caseworker', 'inbox.read'),
  ('caseworker', 'inbox.triage'),
  ('caseworker', 'contacts.read'),
  ('caseworker', 'contacts.write'),
  ('caseworker', 'contacts.merge'),
  ('caseworker', 'cases.read'),
  ('caseworker', 'cases.write'),
  ('caseworker', 'cases.read_sensitive'),
  ('caseworker', 'classification.review'),
  ('caseworker', 'tasks.write'),
  ('caseworker', 'communications.draft'),
  ('viewer', 'legislation.read'),
  ('viewer', 'reports.read')) AS t(role_key, permission_key) WHERE t.role_key = r.key AND t.permission_key = rp.permission_key);--> statement-breakpoint
INSERT INTO role_permissions (organization_id, role_id, permission_key)
  SELECT r.organization_id, r.id, t.permission_key FROM roles r JOIN (VALUES
  ('owner', 'legislation.read'),
  ('owner', 'legislation.track'),
  ('owner', 'reports.read'),
  ('owner', 'integrations.manage'),
  ('owner', 'team.manage'),
  ('owner', 'settings.manage'),
  ('owner', 'audit.read'),
  ('owner', 'records.export'),
  ('owner', 'inbox.read'),
  ('owner', 'inbox.triage'),
  ('owner', 'contacts.read'),
  ('owner', 'contacts.write'),
  ('owner', 'contacts.merge'),
  ('owner', 'cases.read'),
  ('owner', 'cases.write'),
  ('owner', 'cases.read_sensitive'),
  ('owner', 'classification.review'),
  ('owner', 'taxonomy.manage'),
  ('owner', 'tasks.write'),
  ('owner', 'communications.draft'),
  ('owner', 'communications.approve'),
  ('owner', 'senders.manage'),
  ('owner', 'ledger.read'),
  ('chief_of_staff', 'legislation.read'),
  ('chief_of_staff', 'legislation.track'),
  ('chief_of_staff', 'reports.read'),
  ('chief_of_staff', 'integrations.manage'),
  ('chief_of_staff', 'team.manage'),
  ('chief_of_staff', 'audit.read'),
  ('chief_of_staff', 'inbox.read'),
  ('chief_of_staff', 'inbox.triage'),
  ('chief_of_staff', 'contacts.read'),
  ('chief_of_staff', 'contacts.write'),
  ('chief_of_staff', 'contacts.merge'),
  ('chief_of_staff', 'cases.read'),
  ('chief_of_staff', 'cases.write'),
  ('chief_of_staff', 'cases.read_sensitive'),
  ('chief_of_staff', 'classification.review'),
  ('chief_of_staff', 'taxonomy.manage'),
  ('chief_of_staff', 'tasks.write'),
  ('chief_of_staff', 'communications.draft'),
  ('chief_of_staff', 'communications.approve'),
  ('chief_of_staff', 'senders.manage'),
  ('chief_of_staff', 'ledger.read'),
  ('legislative_aide', 'legislation.read'),
  ('legislative_aide', 'legislation.track'),
  ('legislative_aide', 'reports.read'),
  ('legislative_aide', 'inbox.read'),
  ('legislative_aide', 'inbox.triage'),
  ('legislative_aide', 'contacts.read'),
  ('legislative_aide', 'contacts.write'),
  ('legislative_aide', 'cases.read'),
  ('legislative_aide', 'classification.review'),
  ('legislative_aide', 'tasks.write'),
  ('legislative_aide', 'communications.draft'),
  ('caseworker', 'legislation.read'),
  ('caseworker', 'reports.read'),
  ('caseworker', 'inbox.read'),
  ('caseworker', 'inbox.triage'),
  ('caseworker', 'contacts.read'),
  ('caseworker', 'contacts.write'),
  ('caseworker', 'contacts.merge'),
  ('caseworker', 'cases.read'),
  ('caseworker', 'cases.write'),
  ('caseworker', 'cases.read_sensitive'),
  ('caseworker', 'classification.review'),
  ('caseworker', 'tasks.write'),
  ('caseworker', 'communications.draft')) AS t(role_key, permission_key) ON t.role_key = r.key
ON CONFLICT DO NOTHING;
