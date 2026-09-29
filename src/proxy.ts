import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

export const proxy = auth((req) => {
  const { nextUrl } = req;
  const isLoggedIn = !!req.auth?.user;

  const isAuthPage = nextUrl.pathname.startsWith("/login");
  const isApiAuth = nextUrl.pathname.startsWith("/api/auth");
  const isLanding = nextUrl.pathname === "/";
  // The design-system page: static markup, hardcoded sample data, no query and
  // no session. It exists to be openable when the database is not — which is
  // exactly when it is most needed, and exactly when signing in cannot work,
  // since authentication reads the user table. Dev only; in production it is
  // treated like any other page and requires a login.
  const isUiPreview =
    process.env.NODE_ENV !== "production" && nextUrl.pathname.startsWith("/ui-preview");

  if (isApiAuth || isUiPreview) return;
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
