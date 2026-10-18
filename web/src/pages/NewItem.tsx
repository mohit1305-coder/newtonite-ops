import { useRef, useState } from "react";
import { api, ApiError } from "../api";
import { PRIORITY_LABEL, useMe, useToast } from "../ui";

export default function NewItem() {
  const me = useMe();
  const toast = useToast();
  const teams = me.memberships.filter((m) => m.role !== "viewer");
  const [form, setForm] = useState({ teamId: teams[0]?.teamId ?? "", title: "", description: "", priority: "MEDIUM", dueAt: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One key per form. If the first attempt times out and the user presses the
  // button again, the server recognises the retry and does not create a duplicate.
  const key = useRef(crypto.randomUUID());

  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const item = await api("/items", {
        method: "POST",
        headers: { "Idempotency-Key": key.current },
        body: { ...form, dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null },
      });
      toast.ok("Request created");
      location.hash = `#/items/${item.id}`;
    } catch (err: any) {
      setError(err instanceof ApiError && err.code === "NETWORK" ? `${err.message} It is safe to try again; the request will not be duplicated.` : err.message);
    } finally {
      setBusy(false);
    }
  }

  if (teams.length === 0) return <p className="muted pad">You have view-only access, so you cannot create requests.</p>;

  return (
    <form className="panel narrow" onSubmit={submit}>
      <h2>New request</h2>
      <label>Team
        <select value={form.teamId} onChange={set("teamId")}>
          {teams.map((t) => <option key={t.teamId} value={t.teamId}>{t.teamName}</option>)}
        </select>
      </label>
      <label>Title<input value={form.title} onChange={set("title")} maxLength={200} required autoFocus /></label>
      <label>What happened and what is needed?
        <textarea rows={5} value={form.description} onChange={set("description")} />
      </label>
      <div className="two">
        <label>Priority
          <select value={form.priority} onChange={set("priority")}>
            {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Due<input type="datetime-local" value={form.dueAt} onChange={set("dueAt")} /></label>
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn" disabled={busy || !form.title.trim()}>{busy ? "Creating…" : "Create request"}</button>
    </form>
  );
}
