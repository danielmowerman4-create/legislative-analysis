ALTER TABLE "office_settings" ADD COLUMN "address_lookup_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "office_settings" ADD COLUMN "template_overlap" real DEFAULT 0.7 NOT NULL;--> statement-breakpoint
ALTER TABLE "office_settings" ADD COLUMN "template_min_words" integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "office_settings" ADD COLUMN "ai_guidance" text;--> statement-breakpoint
ALTER TABLE "contact_addresses" ADD COLUMN "normalized" text;--> statement-breakpoint
ALTER TABLE "contact_addresses" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_addresses" ADD COLUMN "lookup_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_addresses" ADD COLUMN "looked_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact_addresses" ADD COLUMN "district" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "district_status" text;--> statement-breakpoint
ALTER TABLE "issue_positions" ADD COLUMN "requested_action" text;--> statement-breakpoint
CREATE INDEX "email_messages_template_cluster_idx" ON "email_messages" USING btree ("template_cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_addresses_norm_uq" ON "contact_addresses" USING btree ("contact_id","normalized");