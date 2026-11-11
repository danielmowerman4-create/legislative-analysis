-- Tenant isolation: application queries run as li_app (no BYPASSRLS, not table owner) with
-- app.org_id / app.user_id set per transaction. The owner connection is used only by auth,
-- webhooks, the job runner and migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'li_app') THEN
    CREATE ROLE li_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  -- Lets a non-superuser owner connection SET ROLE li_app. Superusers do not need it.
  EXECUTE format('GRANT li_app TO %I', current_user);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'GRANT li_app skipped: %', SQLERRM;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO li_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_org_id(), app_user_id() TO li_app;
--> statement-breakpoint
-- Every table with an organization_id column is tenant-owned: enable RLS, add the tenant policy,
-- grant DML to li_app. A test asserts no tenant table is missing RLS.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO li_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id())',
      r.table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO li_app', r.table_name);
  END LOOP;
END $$;
--> statement-breakpoint
-- Private notes are visible only to their author, even inside the office.
DROP POLICY IF EXISTS tenant_isolation ON contact_notes;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON contact_notes TO li_app
  USING (organization_id = app_org_id() AND (visibility = 'office' OR author_id = app_user_id()))
  WITH CHECK (organization_id = app_org_id() AND (visibility = 'office' OR author_id = app_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON case_events;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON case_events TO li_app
  USING (organization_id = app_org_id() AND (visibility = 'office' OR actor_id = app_user_id()))
  WITH CHECK (organization_id = app_org_id() AND (visibility = 'office' OR actor_id = app_user_id()));
--> statement-breakpoint
-- background_jobs got the tenant policy above (global jobs have a null organization_id and are invisible to li_app).
-- li_app may only read and enqueue; the job runner (owner) updates job state.
REVOKE UPDATE, DELETE ON background_jobs FROM li_app;
--> statement-breakpoint
-- The organization row itself.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organizations TO li_app USING (id = app_org_id()) WITH CHECK (id = app_org_id());
--> statement-breakpoint
GRANT SELECT, UPDATE ON organizations TO li_app;
--> statement-breakpoint
-- Users: li_app may read display columns only (never password or MFA secrets).
GRANT SELECT (id, email, name, theme_preference, mfa_enabled_at, disabled_at, last_login_at, created_at) ON users TO li_app;
--> statement-breakpoint
GRANT SELECT ON permissions TO li_app;
--> statement-breakpoint
-- Public legislative data: read-only for li_app; written only by the sync worker (owner).
GRANT SELECT ON jurisdictions, legislative_sessions, bills, bill_versions, bill_actions, bill_status_history,
  legislators, bill_sponsors, committees, bill_committee_links, amendments, roll_calls, roll_call_votes,
  legislative_events, legislative_source_syncs TO li_app;
--> statement-breakpoint
-- Semantic search indexes (HNSW, cosine).
CREATE INDEX IF NOT EXISTS email_messages_embedding_idx ON email_messages USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bills_embedding_idx ON bills USING hnsw (embedding vector_cosine_ops);
