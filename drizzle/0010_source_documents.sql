CREATE TABLE "source_documents" (
	"url" text PRIMARY KEY NOT NULL,
	"found" boolean NOT NULL,
	"body" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
