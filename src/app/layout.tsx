import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Legislative Analysis", template: "%s · Legislative Analysis" },
  description: "Bill tracking for state legislative offices: status, hearings, votes, related bills and text comparison.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://use.typekit.net" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://use.typekit.net/mdi6ayn.css" />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
