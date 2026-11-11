CREATE TABLE "bill_alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"last_matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whip_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"legislator_id" uuid NOT NULL,
	"stance" text NOT NULL,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bill_alert_rules" ADD CONSTRAINT "bill_alert_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_alert_rules" ADD CONSTRAINT "bill_alert_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whip_entries" ADD CONSTRAINT "whip_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whip_entries" ADD CONSTRAINT "whip_entries_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whip_entries" ADD CONSTRAINT "whip_entries_legislator_id_legislators_id_fk" FOREIGN KEY ("legislator_id") REFERENCES "public"."legislators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whip_entries" ADD CONSTRAINT "whip_entries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_alert_rules_uq" ON "bill_alert_rules" USING btree ("organization_id","kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "whip_entries_uq" ON "whip_entries" USING btree ("organization_id","bill_id","legislator_id");--> statement-breakpoint
-- Whip counts and alert rules belong to one office.
ALTER TABLE "whip_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "whip_entries" TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "whip_entries" TO li_app;--> statement-breakpoint
ALTER TABLE "bill_alert_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "bill_alert_rules" TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "bill_alert_rules" TO li_app;
