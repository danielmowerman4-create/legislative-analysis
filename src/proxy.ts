import { NextResponse, type NextRequest } from "next/server";
import { returnTo } from "@/lib/return-to";

// Convenience redirect only; every page, action and route re-checks the session.
export function proxy(request: NextRequest) {
  if (!request.cookies.get("li_session")) {
    const url = request.nextUrl.clone();
    const back = returnTo(url.pathname);
    url.pathname = "/login";
    url.search = "";
    if (back) url.searchParams.set("next", back);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|privacy|account/mfa|account/password|no-office|api/|_next/|art/|favicon|icon\\.svg|apple-icon\\.png|robots\\.txt).*)"],
};
