import { FixtureProvider, registerFixtureProvider } from "../legislation/providers/fixture";
import { demoLegislativeDataset } from "./legislative-fixture";

export function registerDemoProviders() {
  if (process.env.APP_ENV !== "demo") throw new Error("Demo providers can only be registered when APP_ENV=demo");
  registerFixtureProvider(new FixtureProvider(demoLegislativeDataset()));
}
