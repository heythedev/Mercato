import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

export const proxy = auth((req) => {
  const { nextUrl } = req;
  const isLoggedIn = !!req.auth?.user;

  const isAuthPage = nextUrl.pathname.startsWith("/login");
  const isApiAuth = nextUrl.pathname.startsWith("/api/auth");
  const isLanding = nextUrl.pathname === "/";

  if (isApiAuth) return;
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
