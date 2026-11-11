import { runMigrations } from "../src/server/db/migrate";
import { closeDb } from "../src/server/db/client";
import { ensurePermissionsCatalog } from "../src/server/services/offices";

runMigrations()
  .then(() => ensurePermissionsCatalog())
  .then(() => console.log("Migrations applied."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
