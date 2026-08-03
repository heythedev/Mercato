"use client";

import { useState } from "react";
import { Users, Plus, Trash2, UserCheck, UserX, X, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-dialog";

type User = { id: string; name: string | null; email: string | null; role: string; createdAt: Date | string };

export function AdminUsersClient({ users: initial }: { users: User[] }) {
  const confirm = useConfirm();
  const [users, setUsers] = useState(initial);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" });

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
      {/* overflow-x-auto lets the table scroll on narrow screens instead of
          being clipped; min-w keeps columns from crushing so content stays
          readable. */}
      <div className="rounded-xl border overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="text-left font-medium px-4 py-2.5 text-muted-foreground">Name</th>
              <th className="text-left font-medium px-4 py-2.5 text-muted-foreground">Email</th>
              <th className="text-left font-medium px-4 py-2.5 text-muted-foreground">Role</th>
              <th className="text-left font-medium px-4 py-2.5 text-muted-foreground">Joined</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b last:border-0 hover:bg-muted/20 transition">
                <td className="px-4 py-3 font-medium">{user.name ?? <span className="text-muted-foreground">—</span>}</td>
                <td className="px-4 py-3 text-muted-foreground">{user.email}</td>
                <td className="px-4 py-3">
                  <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
                    user.role === "admin" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                  )}>
                    {user.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1 justify-end">
                    <button
                      onClick={() => handleToggleRole(user)}
                      title={user.role === "admin" ? "Demote to user" : "Promote to admin"}
                      className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition"
                    >
                      {user.role === "admin" ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
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
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground text-sm">No users yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
