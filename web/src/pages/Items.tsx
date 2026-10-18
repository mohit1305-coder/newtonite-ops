import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ItemRow, PRIORITY_LABEL, STATUS_LABEL, useMe } from "../ui";

export default function Items() {
  const me = useMe();
  const [f, setF] = useState({ teamId: "", status: "", priority: "", assignee: "", q: "", overdue: false });
  const [q, setQ] = useState(""); // debounced search text
  const [items, setItems] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQ(f.q), 300);
    return () => clearTimeout(t);
  }, [f.q]);

  function query(c?: string | null) {
    const p = new URLSearchParams();
    if (f.teamId) p.set("teamId", f.teamId);
    if (f.status) p.set("status", f.status);
    if (f.priority) p.set("priority", f.priority);
    if (f.assignee) p.set("assignee", f.assignee);
    if (q) p.set("q", q);
    if (f.overdue) p.set("overdue", "1");
    if (c) p.set("cursor", c);
    return "/items?" + p.toString();
  }

  async function load(append: boolean) {
    const id = ++requestId.current; // ignore responses that arrive after a newer request
    setLoading(true);
    setError("");
    try {
      const r = await api(query(append ? cursor : null));
      if (id !== requestId.current) return;
      setItems((prev) => (append ? [...prev, ...r.items.filter((n: any) => !prev.some((p) => p.id === n.id))] : r.items));
      setCursor(r.nextCursor);
    } catch (e: any) {
      if (id === requestId.current) setError(e.message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    load(false);
  }, [f.teamId, f.status, f.priority, f.assignee, f.overdue, q]);

  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  return (
    <div>
      <h2>All work</h2>
      <div className="filters">
        <input type="search" placeholder="Search title or description" value={f.q} onChange={set("q")} />
        <select value={f.teamId} onChange={set("teamId")} aria-label="Team">
          <option value="">All teams</option>
          {me.memberships.map((m) => <option key={m.teamId} value={m.teamId}>{m.teamName}</option>)}
        </select>
        <select value={f.status} onChange={set("status")} aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={f.priority} onChange={set("priority")} aria-label="Priority">
          <option value="">Any priority</option>
          {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={f.assignee} onChange={set("assignee")} aria-label="Assignee">
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
        </select>
        <label className="check"><input type="checkbox" checked={f.overdue} onChange={set("overdue")} /> Overdue only</label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="panel list">
        {items.map((i) => <ItemRow key={i.id} item={i} />)}
        {!loading && items.length === 0 && !error && <p className="muted pad">No work matches these filters.</p>}
        {loading && <p className="muted pad">Loading…</p>}
      </div>
      {cursor && !loading && <button className="btn secondary" onClick={() => load(true)}>Load more</button>}
    </div>
  );
}
