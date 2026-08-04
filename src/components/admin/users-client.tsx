"use client";

import { useState } from "react";
import { Users, Plus, Trash2, UserCheck, UserX, X, Eye, EyeOff, KeyRound, Store, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { MARKETPLACE_TILES } from "@/lib/marketplaces/catalog";

type User = {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  allowedMarketplaces: string[];
  createdAt: Date | string;
};

function MarketplaceLogo({ domain, className }: { domain: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      className={cn("shrink-0 rounded-sm", className)}
    />
  );
}

export function AdminUsersClient({ users: initial }: { users: User[] }) {
  const confirm = useConfirm();
  const [users, setUsers] = useState(initial);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" });

  // Which user (if any) each modal is targeting.
  const [pwUser, setPwUser] = useState<User | null>(null);
  const [mpUser, setMpUser] = useState<User | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed"); }
      const user = await res.json();
      setUsers((prev) => [user, ...prev]);
      setForm({ name: "", email: "", password: "", role: "user" });
      setShowAdd(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Delete this user?",
      description: "This cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/users?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      setUsers((prev) => prev.filter((u) => u.id !== id));
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function handleToggleRole(user: User) {
    const newRole = user.role === "admin" ? "user" : "admin";
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, role: newRole }),
      });
      if (!res.ok) throw new Error("Failed to update");
      const updated = await res.json();
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (e) {
      alert((e as Error).message);
    }
  }

  function applyUpdate(updated: User) {
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
  }

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Users className="w-4 h-4" />
          {users.length} user{users.length !== 1 ? "s" : ""}
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition"
        >
          <Plus className="w-3.5 h-3.5" /> Add User
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="mb-4 rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">New User</h3>
            <button onClick={() => { setShowAdd(false); setError(""); }} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          {error && <p className="text-destructive text-sm mb-3">{error}</p>}
          <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              placeholder="Name (optional)"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="h-9 rounded-lg border bg-background px-3 text-sm"
            />
            <input
              placeholder="Email *"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className="h-9 rounded-lg border bg-background px-3 text-sm"
            />
            <div className="relative">
              <input
                placeholder="Password *"
                type={showPw ? "text" : "password"}
                required
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                className="h-9 w-full rounded-lg border bg-background px-3 pr-10 text-sm"
              />
              <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <select
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              className="h-9 rounded-lg border bg-background px-3 text-sm"
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <div className="sm:col-span-2 flex gap-2 justify-end">
              <button type="button" onClick={() => setShowAdd(false)} className="h-8 px-3 rounded-lg border text-sm">Cancel</button>
              <button type="submit" disabled={loading} className="h-8 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                {loading ? "Creating..." : "Create User"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="text-left font-medium px-4 py-2.5 text-muted-foreground">Name</th>
              <th className="text-left font-medium px-4 py-2.5 text-muted-foreground">Email</th>
              <th className="text-left font-medium px-4 py-2.5 text-muted-foreground">Role</th>
              <th className="text-left font-medium px-4 py-2.5 text-muted-foreground">Marketplaces</th>
              <th className="text-left font-medium px-4 py-2.5 text-muted-foreground">Joined</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isAdmin = user.role === "admin";
              return (
              <tr key={user.id} className="border-b last:border-0 hover:bg-muted/20 transition">
                <td className="px-4 py-3 font-medium">{user.name ?? <span className="text-muted-foreground">—</span>}</td>
                <td className="px-4 py-3 text-muted-foreground">{user.email}</td>
                <td className="px-4 py-3">
                  <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
                    isAdmin ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                  )}>
                    {user.role}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {isAdmin ? (
                    <span className="text-xs text-muted-foreground">All</span>
                  ) : user.allowedMarketplaces.length === 0 ? (
                    <span className="text-xs text-muted-foreground">None</span>
                  ) : (
                    <div className="flex items-center gap-1">
                      {user.allowedMarketplaces
                        .map((id) => MARKETPLACE_TILES.find((m) => m.id === id))
                        .filter(Boolean)
                        .map((m) => (
                          <MarketplaceLogo key={m!.id} domain={m!.domain} className="w-4 h-4" />
                        ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1 justify-end">
                    {!isAdmin && (
                      <button
                        onClick={() => setMpUser(user)}
                        title="Manage marketplaces"
                        className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition"
                      >
                        <Store className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => setPwUser(user)}
                      title="Set password"
                      className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition"
                    >
                      <KeyRound className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleToggleRole(user)}
                      title={isAdmin ? "Demote to user" : "Promote to admin"}
                      className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition"
                    >
                      {isAdmin ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => handleDelete(user.id)}
                      className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
            {users.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">No users yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pwUser && (
        <SetPasswordModal
          user={pwUser}
          onClose={() => setPwUser(null)}
        />
      )}
      {mpUser && (
        <ManageMarketplacesModal
          user={mpUser}
          onClose={() => setMpUser(null)}
          onSaved={(u) => { applyUpdate(u); setMpUser(null); }}
        />
      )}
    </div>
  );
}

// ── Set password modal ──────────────────────────────────────────────────────

function SetPasswordModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, password }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed"); }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Set password" subtitle={user.email ?? user.name ?? ""} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div className="relative">
          <input
            autoFocus
            type={show ? "text" : "password"}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password (min 8 chars)"
            className="h-10 w-full rounded-lg border bg-background px-3 pr-10 text-sm"
          />
          <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="h-9 px-4 rounded-lg border text-sm">Cancel</button>
          <button type="submit" disabled={saving || password.length < 8} className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : "Set password"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ── Manage marketplaces modal ───────────────────────────────────────────────

function ManageMarketplacesModal({ user, onClose, onSaved }: {
  user: User;
  onClose: () => void;
  onSaved: (u: User) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(user.allowedMarketplaces));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const allSelected = selected.size === MARKETPLACE_TILES.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(MARKETPLACE_TILES.map((m) => m.id)));
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, allowedMarketplaces: [...selected] }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed"); }
      onSaved(await res.json());
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title="Manage marketplaces"
      subtitle={`${user.email ?? user.name ?? ""} — projects this user can create`}
      onClose={onClose}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{selected.size} of {MARKETPLACE_TILES.length} selected</span>
        <button
          type="button"
          onClick={toggleAll}
          className="text-xs font-medium text-primary hover:underline"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {MARKETPLACE_TILES.map((m) => {
          const on = selected.has(m.id);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => toggle(m.id)}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-all text-sm",
                on ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-primary/40 hover:bg-accent"
              )}
            >
              <MarketplaceLogo domain={m.domain} className="w-5 h-5" />
              <span className="flex-1 font-medium">{m.label}</span>
              {on && <Check className="w-4 h-4 text-primary shrink-0" />}
            </button>
          );
        })}
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 px-4 rounded-lg border text-sm">Cancel</button>
        <button type="button" onClick={save} disabled={saving} className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
          {saving ? "Saving…" : "Save access"}
        </button>
      </div>
    </ModalShell>
  );
}

// ── Shared modal shell ──────────────────────────────────────────────────────

function ModalShell({ title, subtitle, onClose, children }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" className="my-auto w-full max-w-md rounded-2xl border bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-bold tracking-tight">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
