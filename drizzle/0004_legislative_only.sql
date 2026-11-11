CREATE TABLE "bill_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"related_provider_bill_id" text NOT NULL,
	"related_identifier" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "office_bill_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"related_bill_id" uuid NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "code_sections" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_bills" ADD COLUMN "position" text DEFAULT 'watching' NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_bills" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_bills" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bill_relations" ADD CONSTRAINT "bill_relations_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_bill_links" ADD CONSTRAINT "office_bill_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_bill_links" ADD CONSTRAINT "office_bill_links_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_bill_links" ADD CONSTRAINT "office_bill_links_related_bill_id_bills_id_fk" FOREIGN KEY ("related_bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_bill_links" ADD CONSTRAINT "office_bill_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_relations_uq" ON "bill_relations" USING btree ("bill_id","related_provider_bill_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "office_bill_links_uq" ON "office_bill_links" USING btree ("organization_id","bill_id","related_bill_id");--> statement-breakpoint
CREATE INDEX "bills_code_sections_idx" ON "bills" USING gin ("code_sections");--> statement-breakpoint
CREATE INDEX "bills_subjects_idx" ON "bills" USING gin ("subjects");--> statement-breakpoint
-- Office-made bill links are tenant-owned; source-published relations are public data.
ALTER TABLE "office_bill_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "office_bill_links" TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "office_bill_links" TO li_app;--> statement-breakpoint
GRANT SELECT ON "bill_relations" TO li_app;--> statement-breakpoint
-- The product is now legislative only. Existing roles keep reading bills and reports under the new permission names.
INSERT INTO permissions (key, description) VALUES
  ('legislation.read', 'View bills, votes, committees, legislators and the calendar'),
  ('reports.read', 'View and export bill reports')
ON CONFLICT (key) DO UPDATE SET description = excluded.description;--> statement-breakpoint
INSERT INTO role_permissions (organization_id, role_id, permission_key)
  SELECT DISTINCT organization_id, role_id, 'legislation.read' FROM role_permissions WHERE permission_key IN ('inbox.read', 'legislation.track')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO role_permissions (organization_id, role_id, permission_key)
  SELECT DISTINCT organization_id, role_id, 'reports.read' FROM role_permissions WHERE permission_key = 'analytics.read'
ON CONFLICT DO NOTHING;
