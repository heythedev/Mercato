import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { SidebarProvider, SidebarInset } from "@/components/layout/sidebar-context";
import { Sidebar } from "@/components/layout/sidebar";
import { AppNavbar } from "@/components/layout/app-navbar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const role = (user as { role?: string }).role ?? "user";
  const isAdmin = role === "admin";

  // The balance widget always renders — every user runs AI features, and the
  // Kimi balance it shows is the one thing that explains ALL of them failing
  // at once. Only the Amazon-specific rows (Keepa tokens, Synccentric
  // searches) are gated to admins or users granted the Amazon marketplace.
  //
  // This is the only DB call in the layout that wraps the whole authenticated
  // app, so a DB outage here would 500 every page. Degrade instead: if the
  // lookup fails, just hide the Amazon rows — the rest of the UI still renders.
  let showKeepa = isAdmin;
  if (!isAdmin) {
    try {
      const account = await prisma.user.findUnique({
        where: { id: user.id },
        select: { allowedMarketplaces: true },
      });
      showKeepa = account?.allowedMarketplaces.includes("amazon") ?? false;
    } catch (err) {
      console.error("[app-layout] Keepa gate lookup failed; hiding widget", err);
      showKeepa = false;
    }
  }

  return (
    <SidebarProvider>
      <div className="flex min-h-screen">
        <Sidebar role={role} showAmazonSources={showKeepa} />
        <SidebarInset>
          {/* Floating action pill (theme + user menu) — replaces the old navbar */}
          <AppNavbar
            user={{
              id: user.id,
              name: user.name,
              email: user.email,
              role,
            }}
          />
          {/* Clearance for the fixed action pill (top-right) + mobile sidebar
              pill (top-left). Below lg the pills sit above the content (pt);
              at lg+ the whole content region is inset on the right so every
              row — headers, cards, tables — shares one boundary clear of the
              pill. Applied once here so nothing has to pad itself. */}
          <main className="flex-1 pt-14 lg:pt-0 lg:pr-52">{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
