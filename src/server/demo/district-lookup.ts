import type { DistrictLookup } from "../district/lookup";

const TOWNS: Record<string, { house: string; senate: string; city: string }> = {
  millbrook: { house: "42", senate: "7", city: "Millbrook" },
  riverside: { house: "42", senate: "7", city: "Riverside" },
  "oak hollow": { house: "42", senate: "7", city: "Oak Hollow" },
  "cedar falls": { house: "43", senate: "8", city: "Cedar Falls" },
};

export const demoDistrictLookup: DistrictLookup = {
  name: "Demo lookup",
  async locate(address) {
    const city = address.split(",")[1]?.trim().toLowerCase() ?? "";
    const town = TOWNS[city];
    return town ? { status: "matched", ...town } : { status: "not_found" };
  },
};
