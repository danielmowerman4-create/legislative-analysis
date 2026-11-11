ALTER TABLE "legislators" ADD COLUMN "committee_roles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "legislators" ADD COLUMN "title" text;