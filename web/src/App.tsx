import { useEffect, useState } from "react";
import { api, getToken } from "./api";
import { MeCtx, ToastProvider, type Me } from "./ui";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Items from "./pages/Items";
import ItemDetail from "./pages/ItemDetail";
import NewItem from "./pages/NewItem";

function useHash() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function Bell() {
  const [data, setData] = useState<any>({ unread: 0, notifications: [] });
  const [open, setOpen] = useState(false);
  const load = () => api("/notifications").then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  async function toggle() {
    setOpen(!open);
    if (!open && data.unread) {
      await api("/notifications/read-all", { method: "POST" }).catch(() => {});
      setTimeout(load, 1500);
    }
  }
  return (
    <div className="bell">
      <button className="ghost" onClick={toggle} aria-label="Notifications">
        Notifications{data.unread > 0 && <span className="badge">{data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          {data.notifications.length === 0 && <p className="muted pad">You're all caught up.</p>}
          {data.notifications.map((n: any) => (
            <a key={n.id} href={`#/items/${n.itemId}`} onClick={() => setOpen(false)} className={n.readAt ? "" : "unread"}>
              {n.message}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const hash = useHash();

  useEffect(() => {
    if (!getToken()) return;
    api<Me>("/me").then(setMe).catch(() => localStorage.removeItem("token")).finally(() => setChecking(false));
  }, []);

  if (checking) return <p className="muted pad">Loading…</p>;
  if (!me)
    return (
      <ToastProvider>
        <Login onLogin={() => api<Me>("/me").then(setMe)} />
      </ToastProvider>
    );

  const [, route, id] = hash.split("/");
  const canCreate = me.memberships.some((m) => m.role !== "viewer");
  let page;
  if (route === "items" && id === "new") page = <NewItem />;
  else if (route === "items" && id) page = <ItemDetail key={id} id={id} />;
  else if (route === "items") page = <Items />;
  else page = <Dashboard />;

  return (
    <MeCtx.Provider value={me}>
      <ToastProvider>
        <header className="top">
          <a className="brand" href="#/">Ops Desk</a>
          <nav>
            <a href="#/" className={!route ? "active" : ""}>Needs attention</a>
            <a href="#/items" className={route === "items" && !id ? "active" : ""}>All work</a>
          </nav>
          <div className="spacer" />
          {canCreate && <a className="btn" href="#/items/new">New request</a>}
          <Bell />
          <span className="who">{me.user.name}</span>
          <button className="ghost" onClick={() => { localStorage.removeItem("token"); location.hash = "#/"; location.reload(); }}>
            Sign out
          </button>
        </header>
        <main>{page}</main>
      </ToastProvider>
    </MeCtx.Provider>
  );
}
