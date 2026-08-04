import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, ShieldCheck, FolderTree, FileSpreadsheet } from "lucide-react";
import { getCurrentUser } from "@/lib/auth-helpers";
import { ThemeToggle } from "@/components/theme-toggle";
import { MARKETPLACE_TILES } from "@/lib/marketplaces/catalog";

export default async function Home() {
  // Signed-in users skip the landing page entirely.
  const user = await getCurrentUser().catch(() => null);
  if (user) redirect("/projects");

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Soft ambient gradients — violet/indigo, subtle in light, a gentle glow in dark */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 h-[34rem] w-[54rem] -translate-x-1/2 rounded-full bg-gradient-to-br from-violet-300/45 via-fuchsia-200/30 to-transparent blur-3xl dark:from-violet-600/20 dark:via-fuchsia-500/10" />
        <div className="absolute top-1/3 -left-48 h-[28rem] w-[28rem] rounded-full bg-gradient-to-tr from-indigo-300/40 to-transparent blur-3xl dark:from-indigo-500/15" />
        <div className="absolute -right-48 bottom-0 h-[30rem] w-[30rem] rounded-full bg-gradient-to-tl from-purple-300/40 to-transparent blur-3xl dark:from-purple-500/15" />
      </div>

      {/* Header — login pill top left, theme toggle top right */}
      <header className="relative z-10 flex items-center justify-between px-4 py-4 sm:px-8">
        <Link
          href="/login"
          className="inline-flex h-10 items-center gap-1.5 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Login <ArrowRight className="h-4 w-4" />
        </Link>
        <ThemeToggle className="h-10 w-10 rounded-full border bg-background/70 backdrop-blur-md supports-[backdrop-filter]:bg-background/50" />
      </header>

      {/* Hero */}
      <main className="relative z-10 mx-auto flex max-w-3xl flex-col items-center px-6 pt-20 pb-16 text-center sm:pt-28">
        <h1 className="text-5xl font-semibold tracking-wide sm:text-7xl [font-family:var(--font-brand)]">
          Mercato
        </h1>
        <p className="mt-5 text-base text-muted-foreground sm:text-lg">
          Multi-marketplace sourcing, verified and export-ready.
        </p>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Upload a vendor sheet, verify live listings, categorize with marketplace
          taxonomies and export in your template — in minutes, not days.
        </p>

        <Link
          href="/login"
          className="mt-10 inline-flex h-12 items-center gap-2 rounded-full bg-primary px-8 text-sm font-semibold text-primary-foreground shadow-lg transition hover:opacity-90"
        >
          Sign in to get started <ArrowRight className="h-4 w-4" />
        </Link>

        {/* Marketplace strip */}
        <div className="mt-14 flex flex-wrap items-center justify-center gap-2">
          {MARKETPLACE_TILES.map((m) => (
            <span
              key={m.id}
              className="inline-flex items-center gap-2 rounded-full border bg-background/60 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur-sm"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://www.google.com/s2/favicons?domain=${m.domain}&sz=64`}
                alt=""
                className="h-3.5 w-3.5 rounded-sm"
              />
              {m.label}
            </span>
          ))}
        </div>

        {/* Three-step strip — frosted minimal cards */}
        <div className="mt-14 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { icon: ShieldCheck, title: "Verify", text: "Match every SKU against live marketplace listings." },
            { icon: FolderTree, title: "Categorize", text: "Slot products into each marketplace's taxonomy." },
            { icon: FileSpreadsheet, title: "Export", text: "Fill your marketplace template, ready to upload." },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border bg-background/60 p-5 text-left backdrop-blur-md supports-[backdrop-filter]:bg-background/40"
            >
              <f.icon className="h-5 w-5" />
              <h3 className="mt-3 text-sm font-semibold">{f.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.text}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="relative z-10 pb-8 text-center">
        <span className="text-xs text-muted-foreground">© {new Date().getFullYear()} Mercato</span>
      </footer>
    </div>
  );
}
