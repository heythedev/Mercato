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
  // session, so this redirect does not apply â€” and applying it is worse than
  // useless: a 302 to /login answers 200 with an HTML page, so a client sees
  // a successful request containing no JSON-RPC result and reports nothing
  // useful. It must be allowed through to return its own 401.
  const isMcp = nextUrl.pathname.startsWith("/api/mcp");
  // Discovery and the OAuth endpoints, for the same reason and with a sharper
  // edge: a client fetching /.well-known/â€¦ is not a browser with a session,
  // and answering it with a 302 to /login returns 200 and an HTML page. The
  // client then reports "could not connect" with nothing to go on, which is
  // precisely the afternoon this already cost once on /api/mcp.
  //
  const isOauthDiscovery = nextUrl.pathname.startsWith("/.well-known/oauth-");
  const isOauthEndpoint = nextUrl.pathname.startsWith("/api/oauth/");
  // The consent page too, and it is the subtle one. It DOES need a session â€”
  // but this redirect sends an unauthenticated visitor to a bare /login,
  // dropping the query string, so after signing in they arrive at /projects
  // and the client that sent them waits for a callback that will never come.
  // The page carries its own redirect which preserves every parameter and
  // comes back to finish the authorization; it just has to be allowed to run.
  const isOauthConsent = nextUrl.pathname === "/oauth/authorize";
  // The ticketed upload. Authenticated by a one-time ticket in the query, not
  // by a session — whoever runs it may have no browser at all, which is the
  // whole reason it exists. Redirecting it to /login would answer a file
  // upload with an HTML page and a 200, the same failure that made /api/mcp
  // look unreachable.
  const isTicketUpload = nextUrl.pathname === "/api/projects/upload";
  // The ticketed export download, for the same reason as the upload: the
  // ticket IS the credential, and a redirect to /login would answer a file
  // request with an HTML page and a 200.
  const isTicketDownload = nextUrl.pathname === "/api/exports/download";
  // The design-system page: static markup, hardcoded sample data, no query and
  // no session. It exists to be openable when the database is not â€” which is
  // exactly when it is most needed, and exactly when signing in cannot work,
  // since authentication reads the user table. On by default in development
  // only; UI_PREVIEW_ENABLED shows it on a deployment while reviewing.
  const isUiPreview = flags.uiPreview() && nextUrl.pathname.startsWith("/ui-preview");

  if (isApiAuth || isUiPreview || isMcp || isOauthDiscovery || isOauthEndpoint || isOauthConsent || isTicketUpload || isTicketDownload) return;
  if (isAuthPage || isLanding) {
    // Public pages â€” but signed-in users go straight to the app.
    if (isLoggedIn) return Response.redirect(new URL("/projects", nextUrl));
    return;
  }
  if (!isLoggedIn) return Response.redirect(new URL("/login", nextUrl));
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$).*)"],
};
