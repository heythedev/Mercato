import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { flags } from "@/lib/flags";

const { auth } = NextAuth(authConfig);

export const proxy = auth((req) => {
  const { nextUrl } = req;
  const isLoggedIn = !!req.auth?.user;

  const isAuthPage = nextUrl.pathname.startsWith("/login");
  const isApiAuth = nextUrl.pathname.startsWith("/api/auth");
  const isLanding = nextUrl.pathname === "/";
  // The MCP endpoint authenticates with a bearer token, not a browser
  // session, so this redirect does not apply — and applying it is worse than
  // useless: a 302 to /login answers 200 with an HTML page, so a client sees
  // a successful request containing no JSON-RPC result and reports nothing
  // useful. It must be allowed through to return its own 401.
  const isMcp = nextUrl.pathname.startsWith("/api/mcp");
  // The design-system page: static markup, hardcoded sample data, no query and
  // no session. It exists to be openable when the database is not — which is
  // exactly when it is most needed, and exactly when signing in cannot work,
  // since authentication reads the user table. On by default in development
  // only; UI_PREVIEW_ENABLED shows it on a deployment while reviewing.
  const isUiPreview = flags.uiPreview() && nextUrl.pathname.startsWith("/ui-preview");

  if (isApiAuth || isUiPreview || isMcp) return;
  if (isAuthPage || isLanding) {
    // Public pages — but signed-in users go straight to the app.
    if (isLoggedIn) return Response.redirect(new URL("/projects", nextUrl));
    return;
  }
  if (!isLoggedIn) return Response.redirect(new URL("/login", nextUrl));
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$).*)"],
};
