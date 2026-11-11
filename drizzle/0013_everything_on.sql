ALTER TABLE "office_settings" ALTER COLUMN "ai_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "office_settings" ALTER COLUMN "ai_consent_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "office_settings" ALTER COLUMN "center_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "office_settings" ALTER COLUMN "address_lookup_enabled" SET DEFAULT true;--> statement-breakpoint
-- Every office has every feature. Each one can still be turned off in Settings.
UPDATE "office_settings" SET "center_enabled" = true, "center_enabled_at" = coalesce("center_enabled_at", now()), "address_lookup_enabled" = true, "ai_enabled" = true, "ai_consent_at" = coalesce("ai_consent_at", now());
