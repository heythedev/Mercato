"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type SidebarContextValue = {
  collapsed: boolean;
  toggleCollapsed: () => void;
  mobileOpen: boolean;
  toggleMobile: () => void;
  closeMobile: () => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

const STORAGE_KEY = "mercato:sidebar-collapsed";

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) setCollapsed(stored === "true");
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }

  return (
    <SidebarContext.Provider
      value={{
        collapsed,
        toggleCollapsed,
        mobileOpen,
        toggleMobile: () => setMobileOpen((o) => !o),
        closeMobile: () => setMobileOpen(false),
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within a SidebarProvider");
  return ctx;
}

export function SidebarInset({ children }: { children: ReactNode }) {
  const { collapsed } = useSidebar();
  // Sidebar card: left-4 (16px) + w-60 (240px) → right edge at 256px, so open
  // content starts at ml-68 (272px) leaving a 16px gutter. Collapsed, the card
  // slides to a ~32px sliver and uncovers the backdrop "Mercato" wordmark
  // (left-16, ends ~152px), so content stops at ml-44 (176px) to leave it room.
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col transition-[margin] duration-300 ease-in-out",
        collapsed ? "md:ml-44" : "md:ml-68"
      )}
    >
      {children}
    </div>
  );
}
