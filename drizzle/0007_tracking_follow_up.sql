ALTER TABLE "legislators" ADD COLUMN "contact" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_bills" ADD COLUMN "assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "tracked_bills" ADD COLUMN "next_step" text;--> statement-breakpoint
ALTER TABLE "tracked_bills" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "tracked_bills" ADD CONSTRAINT "tracked_bills_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;