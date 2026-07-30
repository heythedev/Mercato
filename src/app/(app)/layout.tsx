import { requireUser } from "@/lib/auth-helpers";
import { SidebarProvider, SidebarInset } from "@/components/layout/sidebar-context";
import { Sidebar } from "@/components/layout/sidebar";
import { AppNavbar } from "@/components/layout/app-navbar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const role = (user as { role?: string }).role ?? "user";

  return (
    <SidebarProvider>
      <div className="flex min-h-screen">
        <Sidebar role={role} />
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
