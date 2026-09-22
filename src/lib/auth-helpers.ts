import { redirect } from "next/navigation";
import { auth } from "@/auth";

export async function getCurrentUser() {
  const session = await auth();
  return session?.user ?? null;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if ((user as { role?: string }).role !== "admin") redirect("/projects");
  return user;
}

/**
 * Page guard for the admin screens a team administers within its own scope.
 *
 * The page still has to scope what it queries; this only decides who may open
 * it at all. A team_admin with no team is refused — the role alone is not a
 * scope, so there would be nothing for them to administer.
 */
export async function requireAnyAdmin() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const role = (user as { role?: string }).role;
  const teamId = (user as { teamId?: string | null }).teamId;
  if (role !== "admin" && !(role === "team_admin" && teamId)) redirect("/projects");
  return user;
}

function jsonResponse(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function adminGuard() {
  const session = await auth();
  if (!session?.user) return { response: jsonResponse("Unauthorized", 401) };
  if ((session.user as { role?: string }).role !== "admin") return { response: jsonResponse("Forbidden", 403) };
  return { user: session.user };
}

/**
 * Admits the super admin OR a team admin.
 *
 * Use for screens a team administers within its own scope — its people, its
 * templates, its export defaults. The handler still has to apply the scope;
 * this only says "is an administrator of something".
 */
export async function anyAdminGuard() {
  const session = await auth();
  if (!session?.user) return { response: jsonResponse("Unauthorized", 401) };
  const role = (session.user as { role?: string }).role;
  const teamId = (session.user as { teamId?: string | null }).teamId;
  const ok = role === "admin" || (role === "team_admin" && !!teamId);
  if (!ok) return { response: jsonResponse("Forbidden", 403) };
  return { user: session.user };
}

export async function authGuard() {
  const session = await auth();
  if (!session?.user) return { response: jsonResponse("Unauthorized", 401) };
  return { user: session.user };
}
