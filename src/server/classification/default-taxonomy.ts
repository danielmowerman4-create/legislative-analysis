export type TaxonomySeed = { key: string; label: string; keywords: string[]; children?: TaxonomySeed[] };

const DEFAULT_TAXONOMY: TaxonomySeed[] = [
  {
    key: "education",
    label: "Education",
    keywords: ["school", "schools", "education", "public schools", "classroom", "school district"],
    children: [
      { key: "education.school_funding", label: "School funding", keywords: ["school funding", "education funding", "per-pupil", "per pupil", "school funding formula", "education funding formula", "QBE", "school budget", "fund our schools", "funding for schools", "cuts to schools", "school funding cuts", "school+funding", "schools+funding", "fondos para las escuelas"] },
      { key: "education.teacher_pay", label: "Teacher compensation", keywords: ["teacher pay", "teacher salary", "teacher salaries", "teachers' pay", "teacher raises", "pay teachers", "educator pay", "teacher compensation"] },
      { key: "education.curriculum", label: "Curriculum", keywords: ["curriculum", "textbook", "textbooks", "library books", "reading standards", "divisive concepts", "sex education"] },
      { key: "education.special_education", label: "Special education", keywords: ["special education", "special ed", "IEP", "504 plan", "students with disabilities", "autism services"] },
      { key: "education.transportation", label: "School transportation", keywords: ["school bus", "school buses", "school bus driver", "school bus drivers", "school bus route", "school bus routes"] },
      { key: "education.school_choice", label: "School choice and vouchers", keywords: ["voucher", "vouchers", "school choice", "education savings account", "charter school", "charter schools", "promise scholarship"] },
      { key: "education.higher_ed", label: "Higher education", keywords: ["university", "college tuition", "HOPE scholarship", "technical college", "student loans", "university system"] },
      { key: "education.school_safety", label: "School safety", keywords: ["school safety", "school shooting", "school resource officer", "metal detectors"] },
    ],
  },
  {
    key: "transportation",
    label: "Transportation",
    keywords: ["transportation", "traffic", "commute"],
    children: [
      { key: "transportation.road_maintenance", label: "Road maintenance", keywords: ["pothole", "potholes", "road repair", "repave", "repaving", "road conditions", "resurfacing", "road maintenance"] },
      { key: "transportation.public_transit", label: "Public transit", keywords: ["public transit", "bus service", "bus route", "bus routes", "bus stop", "bus stops", "transit", "MARTA", "commuter rail", "light rail", "bus rapid transit"] },
      { key: "transportation.traffic_safety", label: "Traffic safety", keywords: ["traffic safety", "speeding", "crosswalk", "traffic light", "stop sign", "pedestrian safety", "speed camera", "speed cameras", "distracted driving", "hands-free", "traffic camera", "traffic cameras", "red light camera", "cameras+tickets"] },
      { key: "transportation.infrastructure_funding", label: "Infrastructure funding", keywords: ["infrastructure funding", "gas tax", "fuel tax", "transportation funding", "bridge repair", "highway funding"] },
      { key: "transportation.driver_services", label: "Driver licensing and vehicles", keywords: ["driver's license", "drivers license", "license renewal", "vehicle registration", "tag renewal", "license plate", "licencia de conducir", "licencia de manejar", "suspended license", "license suspended", "suspended my license", "DMV", "DDS"] },
    ],
  },
  {
    key: "healthcare",
    label: "Healthcare",
    keywords: ["health care", "healthcare", "health insurance", "doctor", "hospital"],
    children: [
      { key: "healthcare.medicaid", label: "Medicaid", keywords: ["medicaid", "medicaid expansion", "pathways", "peachcare", "CHIP"] },
      { key: "healthcare.hospital_access", label: "Hospital access", keywords: ["rural hospital", "rural hospitals", "hospital closure", "emergency room", "hospital access", "certificate of need"] },
      { key: "healthcare.prescription_costs", label: "Prescription costs", keywords: ["prescription", "prescriptions", "insulin", "drug prices", "drug costs", "pharmacy benefit", "PBM"] },
      { key: "healthcare.public_health", label: "Public health", keywords: ["public health", "vaccine", "vaccines", "vaccination", "health department", "outbreak"] },
      { key: "healthcare.mental_health", label: "Mental health", keywords: ["mental health", "behavioral health", "suicide prevention", "crisis line", "988", "psychiatric"] },
      { key: "healthcare.reproductive", label: "Reproductive health", keywords: ["abortion", "reproductive", "heartbeat bill", "IVF", "contraception", "pregnancy"] },
    ],
  },
  {
    key: "taxes",
    label: "Taxes and budget",
    keywords: ["tax", "taxes", "budget", "state budget"],
    children: [
      { key: "taxes.property_tax", label: "Property tax", keywords: ["property tax", "property taxes", "homestead exemption", "assessment", "millage", "property assessment", "tax assessor", "impuestos a la propiedad"] },
      { key: "taxes.income_tax", label: "Income tax", keywords: ["income tax", "flat tax", "tax rebate", "tax refund", "reembolso de impuestos"] },
      { key: "taxes.sales_tax", label: "Sales tax", keywords: ["sales tax", "SPLOST", "ESPLOST", "LOST"] },
      { key: "taxes.state_budget", label: "State budget and spending", keywords: ["state budget", "appropriations", "surplus", "rainy day fund", "state spending"] },
    ],
  },
  {
    key: "public_safety",
    label: "Public safety and justice",
    keywords: ["crime", "public safety"],
    children: [
      { key: "public_safety.policing", label: "Policing", keywords: ["police", "policing", "law enforcement", "sheriff", "officers"] },
      { key: "public_safety.guns", label: "Firearms", keywords: ["gun", "guns", "firearm", "firearms", "constitutional carry", "background check", "background checks", "safe storage", "red flag"] },
      { key: "public_safety.criminal_justice", label: "Criminal justice reform", keywords: ["cash bail", "bail reform", "sentencing", "parole", "expungement", "record restriction", "incarceration"] },
      { key: "public_safety.corrections", label: "Prisons and corrections", keywords: ["prison", "prisons", "corrections", "jail conditions", "inmates"] },
      { key: "public_safety.courts", label: "Courts", keywords: ["court backlog", "judges", "public defender", "jury"] },
    ],
  },
  {
    key: "economy",
    label: "Economy and jobs",
    keywords: ["economy", "job market", "economic"],
    children: [
      { key: "economy.small_business", label: "Small business", keywords: ["small business", "small businesses", "licensing fees", "business license"] },
      { key: "economy.wages", label: "Wages and labor", keywords: ["minimum wage", "living wage", "labor union", "labor unions", "overtime pay", "right to work", "wage theft", "workers' rights", "collective bargaining"] },
      { key: "economy.unemployment", label: "Unemployment insurance", keywords: ["unemployment", "unemployment benefits", "unemployment claim", "jobless claim", "UI claim", "desempleo"] },
      { key: "economy.development", label: "Economic development and incentives", keywords: ["tax incentives for", "business incentives", "film tax credit", "data center", "data centers", "economic development"] },
    ],
  },
  {
    key: "housing",
    label: "Housing",
    keywords: ["housing", "rent", "landlord"],
    children: [
      { key: "housing.affordability", label: "Affordability", keywords: ["affordable housing", "housing costs", "rent increase", "rent increases", "housing affordability"] },
      { key: "housing.tenant_rights", label: "Tenant rights and eviction", keywords: ["eviction", "evictions", "tenant", "tenants", "landlord", "security deposit", "habitability", "desalojo", "desalojar"] },
      { key: "housing.zoning", label: "Zoning and development", keywords: ["zoning", "rezoning", "development", "subdivision", "annexation", "warehouse"] },
      { key: "housing.homelessness", label: "Homelessness", keywords: ["homeless", "homelessness", "unhoused", "shelter"] },
    ],
  },
  {
    key: "environment",
    label: "Environment and energy",
    keywords: ["environment", "environmental", "pollution"],
    children: [
      { key: "environment.water", label: "Water quality and supply", keywords: ["water quality", "drinking water", "water supply", "aquifer", "groundwater", "river pollution", "PFAS"] },
      { key: "environment.energy", label: "Energy and utilities", keywords: ["power bill", "power bills", "electric bill", "utility rates", "Public Service Commission", "solar", "nuclear", "energy costs", "Georgia Power"] },
      { key: "environment.land", label: "Land, mining and conservation", keywords: ["mining", "Okefenokee", "conservation", "wetlands", "landfill", "coal ash"] },
      { key: "environment.climate", label: "Climate", keywords: ["climate change", "emissions", "carbon", "electric vehicle", "electric vehicles", "EV charging"] },
    ],
  },
  {
    key: "elections",
    label: "Elections and government",
    keywords: ["election", "elections", "election officials"],
    children: [
      { key: "elections.voting_access", label: "Voting access", keywords: ["voter ID", "absentee", "early voting", "drop box", "drop boxes", "voter registration", "polling place"] },
      { key: "elections.administration", label: "Election administration", keywords: ["election board", "hand count", "ballot", "ballots", "voting machines", "certification", "election integrity"] },
      { key: "elections.ethics", label: "Ethics and transparency", keywords: ["ethics", "transparency", "open records", "campaign finance", "lobbying reform", "lobbyist gifts", "lobbyist disclosure", "corruption"] },
      { key: "elections.redistricting", label: "Redistricting", keywords: ["redistricting", "gerrymandering", "district maps"] },
    ],
  },
  {
    key: "social_services",
    label: "Social services",
    keywords: ["public assistance", "social services"],
    children: [
      { key: "social_services.snap", label: "Food assistance (SNAP/WIC)", keywords: ["SNAP", "food stamps", "EBT", "WIC", "food assistance", "estampillas de comida", "cupones de alimentos"] },
      { key: "social_services.child_welfare", label: "Child welfare and foster care", keywords: ["foster care", "DFCS", "child welfare", "adoption", "child protective"] },
      { key: "social_services.child_care", label: "Child care", keywords: ["child care", "childcare", "daycare", "pre-k", "pre-K", "CAPS"] },
      { key: "social_services.disability", label: "Disability services", keywords: ["disability benefits", "NOW waiver", "COMP waiver", "developmental disabilities", "disability services"] },
      { key: "social_services.seniors", label: "Seniors and aging", keywords: ["senior citizens", "seniors on fixed incomes", "aging services", "nursing home", "nursing homes", "elder care", "senior center", "assisted living"] },
    ],
  },
  {
    key: "veterans",
    label: "Veterans and military",
    keywords: ["veteran", "veterans", "military"],
    children: [{ key: "veterans.benefits", label: "Veterans benefits", keywords: ["VA benefits", "veterans benefits", "GI bill", "military families"] }],
  },
  {
    key: "immigration",
    label: "Immigration",
    keywords: ["immigration", "immigrant", "immigrants"],
    children: [{ key: "immigration.enforcement", label: "Immigration enforcement", keywords: ["ICE", "287(g)", "deportation", "sanctuary", "undocumented", "inmigración"] }],
  },
  {
    key: "civil_rights",
    label: "Civil rights",
    keywords: ["civil rights", "discrimination"],
    children: [
      { key: "civil_rights.lgbtq", label: "LGBTQ issues", keywords: ["LGBTQ", "transgender", "gender-affirming", "same-sex"] },
      { key: "civil_rights.religious_freedom", label: "Religious freedom", keywords: ["religious freedom", "RFRA", "religious liberty"] },
      { key: "civil_rights.hate_crimes", label: "Hate crimes and antisemitism", keywords: ["hate crime", "hate crimes", "antisemitism", "antisemitic"] },
    ],
  },
  {
    key: "agriculture",
    label: "Agriculture and rural issues",
    keywords: ["farm", "farmers", "agriculture", "rural"],
    children: [
      { key: "agriculture.farming", label: "Farming", keywords: ["farmers", "crop", "crops", "poultry", "timber", "hemp"] },
      { key: "agriculture.broadband", label: "Rural broadband", keywords: ["broadband", "internet access", "high-speed internet"] },
    ],
  },
  {
    key: "consumer",
    label: "Consumer protection",
    keywords: ["consumer"],
    children: [
      { key: "consumer.insurance", label: "Insurance rates", keywords: ["insurance rates", "car insurance", "auto insurance", "homeowners insurance", "insurance premium"] },
      { key: "consumer.scams", label: "Scams and fraud", keywords: ["scam", "scams", "fraud", "identity theft"] },
      { key: "consumer.gambling", label: "Gambling and sports betting", keywords: ["sports betting", "gambling", "casino", "casinos", "lottery"] },
    ],
  },
  { key: "other", label: "Other", keywords: [] },
];

type FlatNode = { key: string; parentKey: string | null; label: string; keywords: string[]; sortOrder: number };

export function flattenTaxonomy(nodes = DEFAULT_TAXONOMY, parentKey: string | null = null): FlatNode[] {
  const out: FlatNode[] = [];
  nodes.forEach((n, i) => {
    out.push({ key: n.key, parentKey, label: n.label, keywords: n.keywords, sortOrder: i });
    if (n.children) out.push(...flattenTaxonomy(n.children, n.key));
  });
  return out;
}
