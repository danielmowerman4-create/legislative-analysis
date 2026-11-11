-- A road or transit "funding formula" is not school funding, and a lobbyist signing a letter is not writing about
-- ethics. Offices that still have the starting keywords get the narrower ones; keywords an office changed stay.
UPDATE "issue_taxonomy"
SET "keywords" = array_remove("keywords", 'funding formula') || ARRAY(SELECT k FROM unnest(ARRAY['school funding formula', 'education funding formula']) AS k WHERE k <> ALL ("keywords"))
WHERE "key" = 'education.school_funding' AND 'funding formula' = ANY ("keywords");
--> statement-breakpoint
UPDATE "issue_taxonomy"
SET "keywords" = array_remove(array_remove("keywords", 'lobbyist'), 'lobbyists') || ARRAY(SELECT k FROM unnest(ARRAY['lobbying reform', 'lobbyist gifts', 'lobbyist disclosure']) AS k WHERE k <> ALL ("keywords"))
WHERE "key" = 'elections.ethics' AND ('lobbyist' = ANY ("keywords") OR 'lobbyists' = ANY ("keywords"));
--> statement-breakpoint
-- Spanish words for what people most often write about, added where an office does not already have them.
UPDATE "issue_taxonomy" SET "keywords" = "keywords" || ARRAY(SELECT k FROM unnest(ARRAY['desempleo']) AS k WHERE k <> ALL ("keywords")) WHERE "key" = 'economy.unemployment';
--> statement-breakpoint
UPDATE "issue_taxonomy" SET "keywords" = "keywords" || ARRAY(SELECT k FROM unnest(ARRAY['licencia de conducir', 'licencia de manejar']) AS k WHERE k <> ALL ("keywords")) WHERE "key" = 'transportation.driver_services';
--> statement-breakpoint
UPDATE "issue_taxonomy" SET "keywords" = "keywords" || ARRAY(SELECT k FROM unnest(ARRAY['desalojo', 'desalojar']) AS k WHERE k <> ALL ("keywords")) WHERE "key" = 'housing.tenant_rights';
--> statement-breakpoint
UPDATE "issue_taxonomy" SET "keywords" = "keywords" || ARRAY(SELECT k FROM unnest(ARRAY['estampillas de comida', 'cupones de alimentos']) AS k WHERE k <> ALL ("keywords")) WHERE "key" = 'social_services.snap';
--> statement-breakpoint
UPDATE "issue_taxonomy" SET "keywords" = "keywords" || ARRAY(SELECT k FROM unnest(ARRAY['reembolso de impuestos']) AS k WHERE k <> ALL ("keywords")) WHERE "key" = 'taxes.income_tax';
--> statement-breakpoint
UPDATE "issue_taxonomy" SET "keywords" = "keywords" || ARRAY(SELECT k FROM unnest(ARRAY['impuestos a la propiedad']) AS k WHERE k <> ALL ("keywords")) WHERE "key" = 'taxes.property_tax';
--> statement-breakpoint
UPDATE "issue_taxonomy" SET "keywords" = "keywords" || ARRAY(SELECT k FROM unnest(ARRAY['inmigración']) AS k WHERE k <> ALL ("keywords")) WHERE "key" = 'immigration.enforcement';
--> statement-breakpoint
UPDATE "issue_taxonomy" SET "keywords" = "keywords" || ARRAY(SELECT k FROM unnest(ARRAY['fondos para las escuelas']) AS k WHERE k <> ALL ("keywords")) WHERE "key" = 'education.school_funding';
--> statement-breakpoint
UPDATE "issue_taxonomy" SET "keywords" = "keywords" || ARRAY(SELECT k FROM unnest(ARRAY['suspended license', 'license suspended', 'suspended my license', 'DMV', 'DDS']) AS k WHERE k <> ALL ("keywords")) WHERE "key" = 'transportation.driver_services';
--> statement-breakpoint
-- A bus route is public transit unless the letter says school bus.
UPDATE "issue_taxonomy"
SET "keywords" = array_remove(array_remove(array_remove("keywords", 'bus route'), 'bus driver'), 'bus drivers') || ARRAY(SELECT k FROM unnest(ARRAY['school bus driver', 'school bus drivers', 'school bus route', 'school bus routes']) AS k WHERE k <> ALL ("keywords"))
WHERE "key" = 'education.transportation' AND 'bus route' = ANY ("keywords");
--> statement-breakpoint
UPDATE "issue_taxonomy" SET "keywords" = "keywords" || ARRAY(SELECT k FROM unnest(ARRAY['bus route', 'bus routes', 'bus stop', 'bus stops']) AS k WHERE k <> ALL ("keywords")) WHERE "key" = 'transportation.public_transit';
