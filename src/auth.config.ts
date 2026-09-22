import type { NextAuthConfig } from "next-auth";

const useSecure = process.env.NODE_ENV === "production";
const sp = useSecure ? "__Secure-" : "";
const cookieOpts = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: useSecure,
};

export const authConfig: NextAuthConfig = {
  trustHost: true,
  session: { strategy: "jwt" },
  cookies: {
    sessionToken: { name: `${sp}mercato.session-token`, options: cookieOpts },
    callbackUrl: { name: `${sp}mercato.callback-url`, options: { ...cookieOpts, httpOnly: false } },
    csrfToken: { name: `${useSecure ? "__Host-" : ""}mercato.csrf-token`, options: cookieOpts },
    pkceCodeVerifier: { name: `${sp}mercato.pkce.code_verifier`, options: { ...cookieOpts, maxAge: 900 } },
    state: { name: `${sp}mercato.state`, options: { ...cookieOpts, maxAge: 900 } },
    nonce: { name: `${sp}mercato.nonce`, options: cookieOpts },
  },
  pages: { signIn: "/login", error: "/login" },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role ?? "user";
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? session.user.id;
        (session.user as { role?: string }).role = (token.role as string) ?? "user";
        // Every authorization decision reads this through actorOf(); without it
        // on the session, a team admin would look team-less and be scoped to
        // nothing at all.
        (session.user as { teamId?: string | null }).teamId = (token.teamId as string | null) ?? null;
      }
      return session;
    },
  },
};
