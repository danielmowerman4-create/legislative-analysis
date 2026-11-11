import { mkdirSync, writeFileSync } from "node:fs";
import { openApiDocument } from "../src/server/api/registry";

mkdirSync("docs", { recursive: true });
writeFileSync("docs/openapi.json", JSON.stringify(openApiDocument(), null, 2) + "\n");
console.log("Wrote docs/openapi.json");
