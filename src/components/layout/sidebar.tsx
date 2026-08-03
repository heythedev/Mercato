"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FolderOpen,
  Users,
  FileText,
  ChevronsLeft,
  ChevronsRight,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebar } from "./sidebar-context";
import { KeepaBalance } from "./keepa-balance";

type Props = {
  role: string;
};

const userNav = [
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/templates", label: "Templates", icon: FileText },
];

const adminNav = [
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/templates", label: "Templates", icon: FileText },
];

export function Sidebar({ role }: Props) {
  const path = usePathname();
  const isAdmin = role === "admin";
  const navItems = isAdmin ? adminNav : userNav;
  const { collapsed, toggleCollapsed, mobileOpen, closeMobile } = useSidebar();

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={closeMobile}
          aria-hidden="true"
        />
      )}

      {/* Backdrop branding — sits BEHIND the card (lower z-index), so the
          sliding card physically covers it when open and uncovers it when
          tucked away. Mirrors the card's exact geometry: 17px = card offset
          (16px) + its 1px border, then the same h-14 px-5 brand row, so the
          uncovered wordmark lands on the very same pixels as the card's own
          brand text. (No transparent border here — the global `* { border-
          color }` rule would repaint it visible.) */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-[17px] top-[17px] z-10 hidden h-14 select-none items-center px-5 md:flex"
      >
        <span className="text-xl font-semibold tracking-wide [font-family:var(--font-brand)]">
          Mercato
        </span>
      </div>

      {/* Floating card. Open: floats detached from the edges. Collapsed
          (desktop): slides left with only a sliver of the card + the arrow
          peeking in from the edge. Mobile: slides fully off-screen. */}
      <aside
        className={cn(
          "fixed bottom-4 left-4 top-4 z-50 flex w-60 flex-col rounded-3xl border border-border/50 bg-card",
          "shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)]",
          "transition-transform duration-300 ease-in-out",
          mobileOpen ? "translate-x-0" : "-translate-x-[120%]",
          // Collapsed leaves a 16px sliver so the wordmark it uncovers (at the
          // card's own brand position) keeps clear air beside it.
          collapsed ? "md:-translate-x-60" : "md:translate-x-0"
        )}
      >
        {/* Collapse toggle: rides the card's right edge, aligned with the brand
            row. When collapsed the card slides left so the toggle ends up to
            the right of the uncovered wordmark — clear of it. */}
        <button
          onClick={toggleCollapsed}
          className="absolute -right-3.5 top-3.5 z-10 hidden h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-md transition hover:text-foreground md:flex"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <ChevronsLeft className="h-4 w-4" />
          )}
        </button>

        {/* Brand */}
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/50 px-5">
          <span className="truncate text-xl font-semibold tracking-wide [font-family:var(--font-brand)]">
            Mercato
          </span>

          <button
            onClick={closeMobile}
            className="ml-auto rounded p-1 hover:bg-accent md:hidden"
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1.5 overflow-y-auto overflow-x-hidden px-3 py-4">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = path.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={closeMobile}
                className={cn(
                  "flex items-center gap-3 rounded-full px-4 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Keepa token balance — pinned to the card footer */}
        <KeepaBalance />
      </aside>
    </>
  );
}
