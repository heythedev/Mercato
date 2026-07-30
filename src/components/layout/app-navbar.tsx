"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { LogOut, ChevronDown, Menu } from "lucide-react";
import { useSidebar } from "./sidebar-context";
import { ThemeToggle } from "@/components/theme-toggle";

type User = { id: string; name?: string | null; email?: string | null; role: string };

/**
 * Floating action pill (top-right) that replaces the old full-width navbar.
 * It only ever held the theme toggle and user menu (plus the mobile sidebar
 * trigger), so a compact frosted pill fits the content better than a whole bar.
 */
export function AppNavbar({ user }: { user: User }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { toggleMobile } = useSidebar();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  return (
    <>
      {/* Mobile sidebar trigger — its own pill on the left, since it opens the
          left sidebar. Hidden on desktop where the sidebar is always visible. */}
      <div className="pointer-events-none fixed left-4 top-4 z-30 md:hidden">
        <button
          onClick={toggleMobile}
          className="pointer-events-auto flex items-center justify-center rounded-full border border-border/60 bg-background/70 p-2.5 text-muted-foreground shadow-lg backdrop-blur-md transition hover:text-foreground supports-[backdrop-filter]:bg-background/50"
          aria-label="Open sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {/* Brand pill — centered between the sidebar trigger and the action
          pill. Mobile only: on desktop the sidebar carries the branding. */}
      <div className="pointer-events-none fixed left-1/2 top-4 z-30 -translate-x-1/2 md:hidden">
        <Link
          href="/projects"
          className="pointer-events-auto flex h-[42px] items-center rounded-full border border-border/60 bg-background/70 px-5 shadow-lg backdrop-blur-md supports-[backdrop-filter]:bg-background/50"
        >
          <span className="text-base font-semibold tracking-wide [font-family:var(--font-brand)]">
            Mercato
          </span>
        </Link>
      </div>

      <div className="pointer-events-none fixed right-4 top-4 z-30">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/60 bg-background/70 p-1 shadow-lg backdrop-blur-md supports-[backdrop-filter]:bg-background/50">
          <ThemeToggle className="rounded-full" />

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex h-8 items-center gap-2 rounded-full pl-1 pr-2.5 text-sm transition hover:bg-accent"
          >
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              {(user.name ?? user.email ?? "U")[0].toUpperCase()}
            </div>
            <span className="hidden max-w-[120px] truncate font-medium sm:block">
              {user.name ?? user.email}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-xl border bg-card shadow-lg">
              <div className="border-b px-3 py-2.5">
                <p className="truncate text-sm font-medium">{user.name ?? "User"}</p>
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                <span className="mt-1 inline-block rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium capitalize text-primary">
                  {user.role}
                </span>
              </div>
              <div className="p-1">
                <button
                  onClick={async () => {
                    setMenuOpen(false);
                    sessionStorage.setItem("mercato:logout-toast", "1");
                    await signOut({ redirect: false });
                    window.location.href = "/login";
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-destructive transition hover:bg-destructive/10"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </>
  );
}
