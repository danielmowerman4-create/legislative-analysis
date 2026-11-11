CREATE TABLE "reply_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"message_id" uuid,
	"connection_id" uuid,
	"to_address" text NOT NULL,
	"to_name" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"rfc_message_id" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "office_settings" ADD COLUMN "reply_signature" text;--> statement-breakpoint
ALTER TABLE "email_connections" ADD COLUMN "sent_folder" jsonb;--> statement-breakpoint
ALTER TABLE "email_connections" ADD COLUMN "send_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_connections" ADD COLUMN "send_enabled_by" uuid;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD COLUMN "sent_via" text;--> statement-breakpoint
ALTER TABLE "email_sync_state" ADD COLUMN "purpose" text DEFAULT 'mail' NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_deliveries" ADD CONSTRAINT "reply_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_deliveries" ADD CONSTRAINT "reply_deliveries_draft_id_email_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."email_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_deliveries" ADD CONSTRAINT "reply_deliveries_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_deliveries" ADD CONSTRAINT "reply_deliveries_connection_id_email_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."email_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reply_deliveries_draft_to_uq" ON "reply_deliveries" USING btree ("draft_id","to_address");--> statement-breakpoint
CREATE INDEX "reply_deliveries_rfc_idx" ON "reply_deliveries" USING btree ("organization_id","rfc_message_id");--> statement-breakpoint
ALTER TABLE "email_connections" ADD CONSTRAINT "email_connections_send_enabled_by_users_id_fk" FOREIGN KEY ("send_enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "reply_deliveries" TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reply_deliveries" TO li_app;
