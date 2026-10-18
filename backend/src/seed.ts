import { pool } from "./db";
import { migrate } from "./migrate";
import { hashPassword } from "./auth";

await migrate();
await pool.query(
  "TRUNCATE notifications, outbox, idempotency_keys, activity_events, work_items, memberships, teams, users CASCADE",
);

const hash = hashPassword("password123");
const userRows = [
  ["alice@example.com", "Alice Rao"],
  ["bob@example.com", "Bob Singh"],
  ["carol@example.com", "Carol Das"],
  ["dave@example.com", "Dave Mehta"],
  ["erin@example.com", "Erin Kapoor"],
];
const users: Record<string, string> = {};
for (const [email, name] of userRows) {
  const r = await pool.query("INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id", [email, name, hash]);
  users[email.split("@")[0]] = r.rows[0].id;
}
const teams: Record<string, string> = {};
for (const name of ["Support", "Engineering", "Finance"]) {
  const r = await pool.query("INSERT INTO teams (name) VALUES ($1) RETURNING id", [name]);
  teams[name] = r.rows[0].id;
}
const memberships: [string, string, string][] = [
  ["alice", "Support", "lead"], ["alice", "Engineering", "lead"],
  ["bob", "Support", "member"],
  ["carol", "Engineering", "member"], ["carol", "Support", "viewer"],
  ["dave", "Finance", "lead"], ["dave", "Support", "member"],
  ["erin", "Finance", "member"], ["erin", "Engineering", "member"],
];
for (const [u, t, role] of memberships)
  await pool.query("INSERT INTO memberships (user_id, team_id, role) VALUES ($1,$2,$3)", [users[u], teams[t], role]);

const subjects = [
  "Payment failed for order", "Production alert on service", "Customer cannot log in",
  "Compliance review needed", "Approve vendor invoice", "Data export request",
  "Refund escalation", "Database latency spike", "Duplicate charge reported",
];
const statuses = ["OPEN", "OPEN", "IN_PROGRESS", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"];
const priorities = ["LOW", "MEDIUM", "MEDIUM", "HIGH", "URGENT"];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

for (const [teamName, teamId] of Object.entries(teams)) {
  const members = memberships.filter((m) => m[1] === teamName && m[2] !== "viewer").map((m) => users[m[0]]);
  for (let i = 1; i <= 300; i++) {
    const status = pick(statuses);
    const assignee = status === "OPEN" ? null : pick(members);
    const ageDays = Math.random() * 20;
    const due = Math.random() < 0.5 ? `now() + interval '${Math.round((Math.random() * 20 - 8) * 24)} hours'` : "NULL";
    await pool.query(
      `INSERT INTO work_items (team_id, title, description, status, priority, reporter_id, assignee_id, due_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,${due}, now() - make_interval(secs => $8::float8 * 86400), now() - make_interval(secs => $9::float8 * 86400))`,
      [teamId, `${pick(subjects)} #${teamName.slice(0, 3).toUpperCase()}-${i}`,
       `Demo ${teamName.toLowerCase()} request ${i}. Needs investigation and a decision.`,
       status, pick(priorities), pick(members), assignee,
       ageDays, ageDays * Math.random()],
    );
  }
}
await pool.query(
  `INSERT INTO activity_events (item_id, team_id, actor_id, type, data, created_at)
   SELECT id, team_id, reporter_id, 'created', jsonb_build_object('title', title, 'priority', priority), created_at FROM work_items`,
);
console.log("Seeded. Log in with e.g. alice@example.com / password123 (lead), bob@example.com (member), carol@example.com (viewer in Support)");
await pool.end();
