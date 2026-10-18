import { useEffect, useState } from "react";
import { api } from "../api";
import { ItemRow } from "../ui";

const SECTIONS: [string, string, string][] = [
  ["mine", "Assigned to you", "Nothing assigned to you right now."],
  ["awaitingApproval", "Waiting for your approval", "No work is waiting on you to approve."],
  ["unassignedUrgent", "High priority and unassigned", "Every urgent request has an owner."],
  ["overdue", "Overdue", "Nothing is past its due date."],
  ["stale", "No update in 3 days", "Nothing in progress has gone quiet."],
];

export default function Dashboard() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/dashboard")
        .then((d) => alive && (setData(d), setError("")))
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 20000); // keep the overview fresh without a manual refresh
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (error && !data) return <p className="error pad">{error}</p>;
  if (!data) return <p className="muted pad">Loading…</p>;

  return (
    <div className="dash">
      <h2>Needs attention</h2>
      {error && <p className="error">Could not refresh: {error}</p>}
      <div className="dash-grid">
        {SECTIONS.map(([key, title, empty]) => (
          <section key={key} className="panel">
            <h3>
              {title} <span className="count">{data[key].total}</span>
            </h3>
            {data[key].items.length === 0 && <p className="muted">{empty}</p>}
            {data[key].items.map((i: any) => <ItemRow key={i.id} item={i} />)}
            {data[key].total > data[key].items.length && (
              <p className="muted small">Showing the top {data[key].items.length}. Use All work to filter the rest.</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
