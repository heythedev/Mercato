import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { authConfig } from "@/auth.config";
import { z } from "zod";

// Thrown when authentication can't be completed for a system reason (e.g. the
// database is unreachable) rather than because the credentials were wrong. The
// `code` surfaces to the client via NextAuth so the login page can show a
// service-unavailable message instead of "Invalid email or password".
class AuthServiceError extends CredentialsSignin {
  code = "ServiceUnavailable";
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const googleEnabled = !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, account }) {
      if (account?.provider === "google" && user?.email) {
        const dbUser = await prisma.user.upsert({
          where: { email: user.email },
          update: { name: user.name ?? undefined },
          create: { email: user.email, name: user.name ?? null, role: "user" },
        });
        token.id = dbUser.id;
        token.role = dbUser.role;
        token.email = dbUser.email;
        token.name = dbUser.name ?? null;
      } else if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role ?? "user";
      }
      return token;
    },
  },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (creds) => {
        const parsed = loginSchema.safeParse(creds);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        // Separate "bad credentials" (return null → "Invalid email or password")
        // from "we couldn't check" (DB down → throw). Without this split, a
        // database outage looks identical to a wrong password and misleads the
        // user into thinking their credentials are bad. The thrown error carries
        // a `code` the login page reads to show a service-unavailable message.
        let user;
        try {
          user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
        } catch (err) {
          console.error("[auth] credential lookup failed (DB unreachable?)", err);
          throw new AuthServiceError();
        }

        if (!user?.password) return null;
        const ok = await bcrypt.compare(password, user.password);
        if (!ok) return null;
        return { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role };
      },
    }),
    ...(googleEnabled
      ? [Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET, allowDangerousEmailAccountLinking: true })]
      : []),
  ],
});
