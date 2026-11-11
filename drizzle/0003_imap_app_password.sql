ALTER TABLE "email_connections" ADD COLUMN "imap_host" text;--> statement-breakpoint
ALTER TABLE "email_connections" ADD COLUMN "imap_port" integer;--> statement-breakpoint
ALTER TABLE "email_connections" ADD COLUMN "app_password_enc" text;