"use client";

import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/theme-toggle";
import { LottieLoader } from "@/components/ui/lottie-loader";

const LOGOUT_TOAST_KEY = "mercato:logout-toast";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem(LOGOUT_TOAST_KEY)) {
      sessionStorage.removeItem(LOGOUT_TOAST_KEY);
      // Deferred so sonner's <Toaster/> has subscribed before the toast is pushed
      // (this effect can otherwise fire before Toaster mounts on a fresh page load).
      const id = setTimeout(() => toast.success("Signed out successfully"), 0);
      return () => clearTimeout(id);
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    let res;
    try {
      res = await signIn("credentials", { email, password, redirect: false });
    } catch {
      // Network-level failure reaching the auth endpoint itself.
      setLoading(false);
      toast.error("Service temporarily unavailable. Please try again shortly.");
      return;
    }
    setLoading(false);
    if (res?.error) {
      // Distinguish a real credential rejection from a system failure (e.g. the
      // database being unreachable), which authorize() flags with this code.
      // Blaming the user's password for a server outage is misleading.
      if (res.code === "ServiceUnavailable") {
        toast.error("Service temporarily unavailable. Please try again shortly.");
      } else {
        toast.error("Invalid email or password");
      }
    } else {
      toast.success("Signed in successfully");
      router.push("/projects");
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4">
      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle className="bg-background" />
      </div>
      <div className="dots-backdrop absolute inset-0" />
      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="inline-block bg-background px-3 py-1 text-4xl font-semibold tracking-wide [font-family:var(--font-brand)]">
            Mercato
          </h1>
          <p className="mt-1">
            <span className="inline-block bg-background px-2 py-0.5 text-sm text-muted-foreground">
              Multi-marketplace sourcing platform
            </span>
          </p>
        </div>

        {/* Card */}
        <div className="bg-card rounded-2xl p-8">
          <h2 className="text-lg font-semibold mb-6">Sign in to your account</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
                className="w-full h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring transition"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="w-full h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring transition"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center gap-2 hover:opacity-90 transition disabled:opacity-60 mt-2"
            >
              {loading && <LottieLoader size={20} onDark className="-my-2" />}
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
