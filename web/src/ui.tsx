import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  IN_REVIEW: "In review",
  DONE: "Done",
  CANCELLED: "Cancelled",
};
export const PRIORITY_LABEL: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" };

export function timeAgo(iso: string) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const StatusChip = ({ status }: { status: string }) => (
  <span className={`chip status-${status}`}>{STATUS_LABEL[status] ?? status}</span>
);

export function ItemRow({ item }: { item: any }) {
  const overdue = item.dueAt && new Date(item.dueAt) < new Date() && !["DONE", "CANCELLED"].includes(item.status);
  return (
    <a className={`row prio-${item.priority}`} href={`#/items/${item.id}`}>
      <div className="row-main">
        <div className="row-title">{item.title}</div>
        <div className="row-meta">
          <span>{item.teamName}</span>
          <span>{item.assigneeName ?? "Unassigned"}</span>
          {item.dueAt && (
            <span className={overdue ? "overdue" : ""}>
              {overdue ? "Overdue since " : "Due "}
              {new Date(item.dueAt).toLocaleDateString()}
            </span>
          )}
          <span>Updated {timeAgo(item.updatedAt)}</span>
        </div>
      </div>
      <div className="row-side">
        <span className="prio-label">{PRIORITY_LABEL[item.priority]}</span>
        <StatusChip status={item.status} />
      </div>
    </a>
  );
}

/* ---- toasts ---- */
type Toast = { id: number; text: string; kind: "ok" | "error" };
const ToastCtx = createContext<{ ok: (t: string) => void; error: (t: string) => void }>({ ok() {}, error() {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={{ ok: (t) => push(t, "ok"), error: (t) => push(t, "error") }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---- current user ---- */
export type Me = {
  user: { id: string; name: string; email: string };
  memberships: { teamId: string; teamName: string; role: "viewer" | "member" | "lead" }[];
};
export const MeCtx = createContext<Me>(null as any);
export const useMe = () => useContext(MeCtx);
