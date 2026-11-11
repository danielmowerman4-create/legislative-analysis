import { getEnv } from "../env";
import { checked, ProviderHttpError, providerFetch } from "../email/providers/http";
import { normalizeDistrict } from "./address";

export type DistrictAnswer = { status: "matched"; house: string | null; senate: string | null; city: string | null } | { status: "not_found" };

export interface DistrictLookup {
  readonly name: string;
  // Street address only: never a name, an email address or anything from the letter.
  locate(address: string): Promise<DistrictAnswer>;
}

const API = "https://api.geocod.io/v2.1/geocode";
// Geocodio accuracy types that place the city or county, not the address.
const NOT_THE_ADDRESS = new Set(["place", "county", "state"]);
const MIN_ACCURACY = 0.8;

type GeocodioDistrict = { district_number?: string | number; proportion?: number };
type GeocodioResult = {
  accuracy?: number;
  accuracy_type?: string;
  address_components?: { city?: string };
  fields?: { state_legislative_districts?: { house?: GeocodioDistrict[]; senate?: GeocodioDistrict[] } };
};

function single(list: GeocodioDistrict[] | undefined) {
  if (!list?.length) return null;
  if (list.length > 1 && (list[0].proportion ?? 0) < 0.99) return null;
  return normalizeDistrict(list[0].district_number);
}

export class GeocodioLookup implements DistrictLookup {
  readonly name = "Geocodio";
  constructor(private readonly key: string) {}

  async locate(address: string): Promise<DistrictAnswer> {
    let body: { results?: GeocodioResult[] };
    try {
      const query = new URLSearchParams({ q: address, fields: "stateleg" });
      const res = await providerFetch(`${API}?${query}`, { headers: { authorization: `Bearer ${this.key}` } });
      body = (await (await checked(res, "Geocodio")).json()) as { results?: GeocodioResult[] };
    } catch (e) {
      if (e instanceof ProviderHttpError && e.status === 422) return { status: "not_found" };
      throw e;
    }
    const best = body.results?.[0];
    if (!best || (best.accuracy ?? 0) < MIN_ACCURACY || NOT_THE_ADDRESS.has(best.accuracy_type ?? "")) return { status: "not_found" };
    const d = best.fields?.state_legislative_districts;
    return { status: "matched", house: single(d?.house), senate: single(d?.senate), city: best.address_components?.city ?? null };
  }
}

const CENSUS = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";

type CensusDistrict = { BASENAME?: string };
type CensusMatch = { addressComponents?: { city?: string }; geographies?: Record<string, CensusDistrict[]> };

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export class CensusLookup implements DistrictLookup {
  readonly name = "U.S. Census Bureau";

  async locate(address: string): Promise<DistrictAnswer> {
    const query = new URLSearchParams({ address, benchmark: "Public_AR_Current", vintage: "Current_Current", layers: "all", format: "json" });
    const res = await providerFetch(`${CENSUS}?${query}`, { headers: { accept: "application/json" } });
    const body = (await (await checked(res, "Census geocoder")).json()) as { result?: { addressMatches?: CensusMatch[] } };
    const match = body.result?.addressMatches?.[0];
    if (!match) return { status: "not_found" };
    const district = (chamber: "Lower" | "Upper") => {
      const layer = Object.entries(match.geographies ?? {}).find(([name]) => name.includes(`State Legislative Districts - ${chamber}`))?.[1];
      return layer?.length === 1 ? normalizeDistrict(layer[0].BASENAME) : null;
    };
    const city = match.addressComponents?.city ? titleCase(match.addressComponents.city) : null;
    return { status: "matched", house: district("Lower"), senate: district("Upper"), city };
  }
}

let override: DistrictLookup | null | undefined;

export function setDistrictLookupForTests(l: DistrictLookup | null | undefined) {
  override = l;
}

export async function districtLookupFor(org: { isDemo: boolean }): Promise<DistrictLookup | null> {
  if (override !== undefined) return override;
  const env = getEnv();
  if (env.APP_ENV === "demo" && org.isDemo) return (await import("../demo/district-lookup")).demoDistrictLookup;
  return env.GEOCODIO_API_KEY ? new GeocodioLookup(env.GEOCODIO_API_KEY) : new CensusLookup();
}
