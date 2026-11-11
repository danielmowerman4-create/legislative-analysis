import type { NextConfig } from "next";

// Next's own page scripts are inline, hence 'unsafe-inline'. Adobe serves the fonts.
const contentPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://use.typekit.net https://p.typekit.net",
  "font-src 'self' data: https://use.typekit.net",
  "img-src 'self' data: blob: https://p.typekit.net",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const productionHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Content-Security-Policy", value: contentPolicy },
];

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Nothing here is for search engines, on any deployment.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  // The dev server needs a looser policy than this.
  ...(process.env.NODE_ENV === "production" ? productionHeaders : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // cacheComponents stays off: pages are per-user and must never enter a shared cache.
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "pg", "bullmq", "ioredis", "imapflow", "nodemailer"],
  turbopack: { rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } } },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Old page names; alerts and bookmarks still point at them.
  async redirects() {
    return [
      { source: "/overview", destination: "/today", permanent: true },
      { source: "/legislation", destination: "/bills", permanent: true },
      { source: "/legislation/:path*", destination: "/bills/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
