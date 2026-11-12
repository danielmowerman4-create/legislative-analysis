CREATE TABLE "office_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"location" text,
	"note" text,
	"bill_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "press_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text DEFAULT 'statement' NOT NULL,
	"headline" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"bill_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"graphic" jsonb,
	"author_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "office_events" ADD CONSTRAINT "office_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_events" ADD CONSTRAINT "office_events_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_events" ADD CONSTRAINT "office_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "press_items" ADD CONSTRAINT "press_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "press_items" ADD CONSTRAINT "press_items_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "press_items" ADD CONSTRAINT "press_items_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "press_items" ADD CONSTRAINT "press_items_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "office_events_starts_idx" ON "office_events" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE INDEX "press_items_updated_idx" ON "press_items" USING btree ("organization_id","updated_at");--> statement-breakpoint
ALTER TABLE "office_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "office_events" TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "office_events" TO li_app;--> statement-breakpoint
ALTER TABLE "press_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "press_items" TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "press_items" TO li_app;
