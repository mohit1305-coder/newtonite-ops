import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { PRIORITY_LABEL, STATUS_LABEL, StatusChip, timeAgo, useToast } from "../ui";

const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const byIdDesc = (a: any, b: any) => Number(b.id) - Number(a.id);

export default function ItemDetail({ id }: { id: string }) {
  const toast = useToast();
  const [item, setItem] = useState<any>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<any[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null); // edit draft (null = not editing)
  const [baseVersion, setBaseVersion] = useState(0); // version the draft was started from
  const [conflict, setConflict] = useState<any>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);

  async function refresh() {
    if (mutating.current) return; // don't overwrite optimistic state mid-request
    try {
      const [it, ev] = await Promise.all([api(`/items/${id}`), api(`/items/${id}/events?limit=30`)]);
      if (mutating.current) return;
      setItem(it);
      setEvents((prev) => {
        const fresh = new Set(ev.events.map((e: any) => e.id));
        return [...ev.events, ...prev.filter((e) => !fresh.has(e.id))].sort(byIdDesc);
      });
      setNextBefore((cur) => cur ?? ev.nextBefore);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000); // pick up other people's changes
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    if (item?.teamId && members.length === 0)
      api(`/teams/${item.teamId}/members`).then((r) => setMembers(r.members)).catch(() => {});
  }, [item?.teamId]);

  const nameOf = (uid: string | null) => (uid ? members.find((m) => m.id === uid)?.name ?? "someone" : "nobody");

  /** Run an action. `optimistic` shows the expected result immediately; the server's answer always wins. */
  async function act(path: string, body?: any, optimistic?: (i: any) => any) {
    const before = item;
    mutating.current = true;
    if (optimistic) setItem({ ...optimistic(item), _pending: true });
    try {
      const updated = await api(path, { method: "POST", body, headers: { "Idempotency-Key": crypto.randomUUID() } });
      setItem(updated);
    } catch (e: any) {
      setItem(before);
      if (e instanceof ApiError && e.details?.current) setItem(e.details.current);
      toast.error(e instanceof ApiError && ["ALREADY_ASSIGNED", "VERSION_CONFLICT"].includes(e.code) ? `${e.message}. Showing the latest version.` : e.message);
    } finally {
      mutating.current = false;
      refresh();
    }
  }

  function startEdit() {
    setForm({ title: item.title, description: item.description, priority: item.priority, dueAt: toLocalInput(item.dueAt) });
    setBaseVersion(item.version);
    setConflict(null);
  }

  async function save() {
    setBusy(true);
    mutating.current = true;
    try {
      const updated = await api(`/items/${id}`, {
        method: "PATCH",
        body: {
          version: baseVersion,
          title: form.title,
          description: form.description,
          priority: form.priority,
          dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
        },
      });
      setItem(updated);
      setForm(null);
      setConflict(null);
      toast.ok("Changes saved");
    } catch (e: any) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        setConflict(e.details.current);
        setItem(e.details.current);
      } else toast.error(e.message);
    } finally {
      mutating.current = false;
      setBusy(false);
      refresh();
    }
  }

  async function sendComment() {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await api(`/items/${id}/comments`, { method: "POST", body: { body: comment }, headers: { "Idempotency-Key": crypto.randomUUID() } });
      setComment("");
      refresh();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadOlder() {
    const r = await api(`/items/${id}/events?limit=30&before=${nextBefore}`);
    setEvents((prev) => [...prev, ...r.events].sort(byIdDesc));
    setNextBefore(r.nextBefore);
  }

  if (error && !item) return <p className="error pad">{error}</p>;
  if (!item) return <p className="muted pad">Loading…</p>;

  const p = item.permissions;
  const remoteChanged = form && !conflict && item.version !== baseVersion;

  function describe(e: any) {
    const d = e.data;
    switch (e.type) {
      case "created": return `created this request (${PRIORITY_LABEL[d.priority] ?? d.priority} priority)`;
      case "comment": return "commented";
      case "status_changed":
        return `moved it from ${STATUS_LABEL[d.from]} to ${STATUS_LABEL[d.to]}${d.auto ? " (automatic)" : ""}`;
      case "assigned":
        if (d.via === "claim") return "took this item";
        if (d.to === null) return d.via === "reopen" ? "cleared the owner when reopening" : `removed ${nameOf(d.from)} as owner`;
        return `assigned it to ${nameOf(d.to)}`;
      case "updated":
        return "edited " + Object.entries(d.changes).map(([k, v]: any) =>
          k === "description" ? "the description" : `${k === "dueAt" ? "due date" : k} (${show(k, v.from)} → ${show(k, v.to)})`).join(", ");
      default: return e.type;
    }
  }
  const show = (k: string, v: any) => (k === "priority" ? PRIORITY_LABEL[v] : k === "dueAt" ? (v ? new Date(v).toLocaleDateString() : "none") : `"${v}"`);

  return (
    <div className="detail">
      <a href="#/items" className="back">Back to all work</a>
      <div className={`panel item prio-${item.priority} ${item._pending ? "pending" : ""}`}>
        {form ? (
          <div className="edit">
            <label>Title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label>Description<textarea rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <div className="two">
              <label>Priority
                <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                  {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label>Due<input type="datetime-local" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} /></label>
            </div>
            {remoteChanged && (
              <div className="banner warn">
                Someone else changed this item while you were editing. Saving will ask you to resolve it.
              </div>
            )}
            {conflict && (
              <div className="banner error-banner">
                <strong>Your changes were not saved.</strong> This item is now at version {conflict.version}
                {" "}(title “{conflict.title}”, {PRIORITY_LABEL[conflict.priority]} priority).
                <div className="actions">
                  <button className="btn" onClick={() => { setBaseVersion(conflict.version); setConflict(null); }}>Keep my edits and overwrite</button>
                  <button className="btn secondary" onClick={() => { setForm(null); setConflict(null); }}>Discard my edits</button>
                </div>
              </div>
            )}
            <div className="actions">
              <button className="btn" disabled={busy || !form.title.trim() || !!conflict} onClick={save}>Save changes</button>
              <button className="btn secondary" onClick={() => { setForm(null); setConflict(null); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="item-head">
              <h2>{item.title}</h2>
              <StatusChip status={item.status} />
            </div>
            <div className="row-meta">
              <span>{item.teamName}</span>
              <span>{PRIORITY_LABEL[item.priority]} priority</span>
              <span>Reported by {item.reporterName}</span>
              <span>{item.assigneeName ? `Owner: ${item.assigneeName}` : "No owner yet"}</span>
              {item.dueAt && <span>Due {new Date(item.dueAt).toLocaleString()}</span>}
              <span>Version {item.version}</span>
            </div>
            <p className="desc">{item.description || <span className="muted">No description.</span>}</p>
            <div className="actions">
              {p.canClaim && <button className="btn" onClick={() => act(`/items/${id}/claim`, undefined, (i) => ({ ...i, assigneeName: "You", status: i.status === "OPEN" ? "IN_PROGRESS" : i.status }))}>Take this</button>}
              {p.transitions.map((to: string) => (
                <button key={to} className="btn secondary" onClick={() => act(`/items/${id}/transition`, { to, version: item.version })}>
                  {to === "DONE" ? "Approve and mark done" : to === "OPEN" ? "Reopen" : `Move to ${STATUS_LABEL[to].toLowerCase()}`}
                </button>
              ))}
              {p.canAssign && (
                <label className="inline">Owner
                  <select value={item.assigneeId ?? ""} onChange={(e) => act(`/items/${id}/assign`, { assigneeId: e.target.value || null, version: item.version })}>
                    <option value="">Unassigned</option>
                    {members.filter((m) => m.role !== "viewer").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
              )}
              {p.canEdit && <button className="btn secondary" onClick={startEdit}>Edit details</button>}
            </div>
          </>
        )}
      </div>

      <section className="panel">
        <h3>History</h3>
        {p.canComment ? (
          <div className="comment-box">
            <textarea rows={2} placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} />
            <button className="btn" disabled={busy || !comment.trim()} onClick={sendComment}>Comment</button>
          </div>
        ) : <p className="muted small">You have view-only access to this team.</p>}
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id} className={`ev ev-${e.type}`}>
              <div><strong>{e.actorName ?? "System"}</strong> {describe(e)} <span className="muted small">{timeAgo(e.createdAt)}</span></div>
              {e.type === "comment" && <div className="comment">{e.data.body}</div>}
              {e.type === "status_changed" && e.data.note && <div className="comment">{e.data.note}</div>}
            </li>
          ))}
        </ol>
        {nextBefore && <button className="btn secondary" onClick={loadOlder}>Show older activity</button>}
      </section>
    </div>
  );
}
