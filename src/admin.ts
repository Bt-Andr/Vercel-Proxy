/**
 * Admin API + UI for managing routes at runtime (no env edit / redeploy).
 *
 *   GET  /__admin                      -> the management UI (token entered in-page)
 *   GET  /__proxy/admin/routes         -> list all route records
 *   POST /__proxy/admin/routes         -> create or update a route (JSON body)
 *   DELETE /__proxy/admin/routes/:key  -> delete a route
 *   POST /__proxy/admin/test           -> probe a backend's reachability
 *
 * All API endpoints require the admin token (Authorization: Bearer <ADMIN_KEY>
 * or X-Admin-Key). The whole admin surface is disabled when ADMIN_KEY is unset,
 * so a misconfigured production deploy is never left wide open.
 */

import type { ResolvedConfig, RouteRecord } from "./types.js";
import { getStore, invalidateRouteCache } from "./store.js";
import { makeRoute } from "./settings.js";
import { safeEqual } from "./util.js";

const ADMIN_BASE = "/__proxy/admin";
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function readAdminKey(request: Request): string | undefined {
  const auth = request.headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return request.headers.get("x-admin-key")?.trim() || undefined;
}

function isAuthorized(request: Request, adminKey: string): boolean {
  const provided = readAdminKey(request);
  return Boolean(provided) && safeEqual(provided as string, adminKey);
}

/** Validate + normalise an incoming route payload from the admin UI. */
function validateRoute(body: unknown): { ok: true; route: RouteRecord } | { ok: false; message: string } {
  if (!body || typeof body !== "object") return { ok: false, message: "JSON body required." };
  const obj = body as Record<string, unknown>;
  const key = typeof obj.key === "string" ? obj.key.trim() : "";
  if (!key) return { ok: false, message: "Field 'key' is required." };
  if (!KEY_PATTERN.test(key)) {
    return { ok: false, message: "Field 'key' may only contain letters, digits, '.', '_' and '-'." };
  }
  const warnings: string[] = [];
  const route = makeRoute(key, obj, warnings);
  if (!route) return { ok: false, message: warnings[0] ?? "Invalid route." };
  route.updatedAt = new Date().toISOString();
  return { ok: true, route };
}

async function probeBackend(target: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const started = Date.now();
  try {
    let res: Response;
    try {
      res = await fetch(target, { method: "HEAD", signal: controller.signal, redirect: "manual" });
    } catch {
      // Some backends reject HEAD — fall back to GET.
      res = await fetch(target, { method: "GET", signal: controller.signal, redirect: "manual" });
    }
    return json({ ok: true, status: res.status, ms: Date.now() - started });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return json(
      { ok: false, error: aborted ? "timeout" : "unreachable", ms: Date.now() - started },
      200,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function handleAdmin(
  request: Request,
  pathname: string,
  config: ResolvedConfig,
): Promise<Response> {
  // Admin is opt-in: without a token configured, it does not exist.
  if (!config.adminKey) {
    return json(
      { error: "admin_disabled", message: "Set the ADMIN_KEY env var to enable the admin." },
      403,
    );
  }

  // The UI page itself carries no secrets; the token is entered in the browser.
  if (pathname === "/__admin") {
    return new Response(ADMIN_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!isAuthorized(request, config.adminKey)) {
    return json({ error: "unauthorized", message: "Valid admin token required." }, 401);
  }

  const store = getStore(config);
  const method = request.method.toUpperCase();
  const sub = pathname.slice(ADMIN_BASE.length); // "/routes", "/routes/<key>", "/test"

  if (sub === "/routes" && method === "GET") {
    const records = await store.list();
    records.sort((a, b) => a.key.localeCompare(b.key));
    return json({ storage: store.kind, ephemeral: store.ephemeral, routes: records });
  }

  if (sub === "/routes" && method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400);
    }
    const result = validateRoute(body);
    if (!result.ok) return json({ error: "invalid", message: result.message }, 400);
    await store.put(result.route);
    invalidateRouteCache();
    return json({ ok: true, route: result.route });
  }

  if (sub.startsWith("/routes/") && method === "DELETE") {
    const key = decodeURIComponent(sub.slice("/routes/".length));
    const removed = await store.remove(key);
    invalidateRouteCache();
    return json({ ok: removed, key }, removed ? 200 : 404);
  }

  if (sub === "/test" && method === "POST") {
    let body: { key?: string; target?: string } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      /* ignore — handled below */
    }
    let target = typeof body.target === "string" ? body.target : "";
    if (!target && body.key) {
      const records = await store.list();
      target = records.find((r) => r.key === body.key)?.target ?? "";
    }
    if (!target) return json({ error: "invalid", message: "Provide 'target' or 'key'." }, 400);
    return probeBackend(target);
  }

  return json({ error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------
// Embedded management UI (dependency-free single page).
// ---------------------------------------------------------------------------

const ADMIN_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Proxy Admin</title>
<style>
  :root { color-scheme: dark; --bg:#0f1117; --panel:#171a23; --line:#262b38; --txt:#e6e8ee; --muted:#8b92a5; --accent:#4f8cff; --danger:#ff5d5d; --ok:#39d98a; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--txt); }
  header { padding:18px 24px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  .badge { font-size:11px; padding:2px 8px; border:1px solid var(--line); border-radius:999px; color:var(--muted); }
  main { max-width:960px; margin:0 auto; padding:24px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:18px; }
  label { display:block; font-size:12px; color:var(--muted); margin:8px 0 4px; }
  input, button { font:inherit; }
  input[type=text], input[type=password] { width:100%; padding:8px 10px; background:#0d0f15; border:1px solid var(--line); border-radius:8px; color:var(--txt); }
  .row { display:grid; grid-template-columns:1fr 2fr auto auto; gap:10px; align-items:end; }
  button { padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:#222838; color:var(--txt); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.ghost { background:transparent; }
  button.danger { color:var(--danger); }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:10px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  td.actions { text-align:right; white-space:nowrap; }
  code { background:#0d0f15; padding:1px 6px; border-radius:6px; color:#cbd2e1; }
  .muted { color:var(--muted); }
  .pill { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); }
  .pill.on { color:var(--ok); border-color:#2a6b50; }
  .pill.off { color:var(--danger); border-color:#6b2a2a; }
  #toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#222838; border:1px solid var(--line); padding:10px 16px; border-radius:8px; opacity:0; transition:opacity .2s; pointer-events:none; }
  #toast.show { opacity:1; }
  .hide { display:none !important; }
  .inline { display:flex; gap:8px; align-items:center; }
  small.hint { color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>⇄ Proxy Admin</h1>
  <span class="badge" id="storageBadge">…</span>
  <span style="flex:1"></span>
  <button class="ghost" id="logoutBtn">Log out</button>
</header>
<main>
  <section id="loginPanel" class="panel hide">
    <label for="token">Admin token (ADMIN_KEY)</label>
    <div class="inline">
      <input type="password" id="token" placeholder="Paste your admin token" autocomplete="off" />
      <button class="primary" id="loginBtn">Unlock</button>
    </div>
    <p class="muted" id="loginErr"></p>
  </section>

  <div id="app" class="hide">
    <section class="panel">
      <strong id="formTitle">Add a destination</strong>
      <div class="row" style="margin-top:10px">
        <div><label>App key</label><input type="text" id="f_key" placeholder="app_x" /></div>
        <div><label>Backend target URL</label><input type="text" id="f_target" placeholder="https://back-x.onrender.com" /></div>
        <div><label>Strip prefix</label><button class="ghost" id="f_strip" data-on="true">Yes</button></div>
        <div><label>&nbsp;</label><button class="primary" id="saveBtn">Save</button></div>
      </div>
      <div class="row" style="grid-template-columns:1fr 2fr auto; margin-top:6px">
        <div><label>Per-route key (optional)</label><input type="text" id="f_secret" placeholder="leave empty for none" /></div>
        <div><label>Custom hosts (comma, optional)</label><input type="text" id="f_hosts" placeholder="api-x.example.com" /></div>
        <div><label>&nbsp;</label><button class="ghost" id="cancelBtn">Clear</button></div>
      </div>
      <small class="hint">Apps then call <code id="exampleUrl">…/&lt;key&gt;/your/path</code></small>
    </section>

    <section class="panel">
      <table>
        <thead><tr><th>Key</th><th>Target</th><th>Strip</th><th>Status</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
      <p class="muted hide" id="empty">No destinations yet. Add one above.</p>
    </section>
  </div>
</main>
<div id="toast"></div>
<script>
const KEY = "proxy_admin_token";
let editing = null;
const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem(KEY) || "";
function toast(msg) { const t=$("toast"); t.textContent=msg; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),1800); }

async function api(method, path, body) {
  const res = await fetch("/__proxy/admin" + path, {
    method,
    headers: { "authorization": "Bearer " + token(), ...(body ? {"content-type":"application/json"} : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(()=>({}));
  return { ok: res.ok, status: res.status, data };
}

function showLogin(err) { $("loginPanel").classList.remove("hide"); $("app").classList.add("hide"); if(err)$("loginErr").textContent=err; }
function showApp() { $("loginPanel").classList.add("hide"); $("app").classList.remove("hide"); }

$("f_strip").onclick = () => { const b=$("f_strip"); const on=b.dataset.on!=="true"; b.dataset.on=String(on); b.textContent=on?"Yes":"No"; };
$("logoutBtn").onclick = () => { sessionStorage.removeItem(KEY); showLogin(""); };
$("cancelBtn").onclick = resetForm;

function resetForm() {
  editing=null; $("formTitle").textContent="Add a destination";
  $("f_key").value=""; $("f_target").value=""; $("f_secret").value=""; $("f_hosts").value="";
  $("f_strip").dataset.on="true"; $("f_strip").textContent="Yes"; $("f_key").disabled=false;
}

$("saveBtn").onclick = async () => {
  const route = {
    key: $("f_key").value.trim(),
    target: $("f_target").value.trim(),
    stripPrefix: $("f_strip").dataset.on==="true",
    keySecret: $("f_secret").value.trim() || undefined,
    hosts: $("f_hosts").value.split(",").map(s=>s.trim()).filter(Boolean),
  };
  const r = await api("POST","/routes", route);
  if (r.ok) { toast("Saved"); resetForm(); load(); }
  else toast(r.data.message || "Error");
};

function editRoute(rt) {
  editing=rt.key; $("formTitle").textContent="Edit "+rt.key;
  $("f_key").value=rt.key; $("f_key").disabled=true;
  $("f_target").value=rt.target;
  $("f_secret").value=rt.keySecret||"";
  $("f_hosts").value=(rt.hosts||[]).join(", ");
  $("f_strip").dataset.on=String(rt.stripPrefix!==false); $("f_strip").textContent=rt.stripPrefix!==false?"Yes":"No";
  window.scrollTo({top:0,behavior:"smooth"});
}

async function del(key) {
  if(!confirm("Delete route '"+key+"'?")) return;
  const r = await api("DELETE","/routes/"+encodeURIComponent(key));
  if (r.ok) { toast("Deleted"); load(); } else toast("Error");
}

async function test(key, btn) {
  btn.textContent="…";
  const r = await api("POST","/test",{key});
  btn.textContent = r.data.ok ? ("✓ "+r.data.status+" ("+r.data.ms+"ms)") : ("✕ "+(r.data.error||"err"));
  setTimeout(()=>btn.textContent="Test", 2500);
}

function render(routes, meta) {
  $("storageBadge").textContent = "storage: " + meta.storage + (meta.ephemeral ? " (ephemeral)" : "");
  $("exampleUrl").textContent = location.origin + "/<key>/your/path";
  const tb=$("rows"); tb.innerHTML="";
  $("empty").classList.toggle("hide", routes.length>0);
  for (const rt of routes) {
    const tr=document.createElement("tr");
    const enabled = rt.disabled!==true;
    tr.innerHTML =
      '<td><code>'+rt.key+'</code></td>'+
      '<td class="muted">'+rt.target+'</td>'+
      '<td>'+(rt.stripPrefix!==false?"yes":"no")+'</td>'+
      '<td><span class="pill '+(enabled?"on":"off")+'">'+(enabled?"active":"disabled")+'</span></td>'+
      '<td class="actions"></td>';
    const td=tr.querySelector(".actions");
    const mk=(label,cls,fn)=>{const b=document.createElement("button");b.textContent=label;if(cls)b.className=cls;b.onclick=()=>fn(b);return b;};
    td.append(
      mk("Test","ghost",(b)=>test(rt.key, b)),
      mk("Edit","ghost",()=>editRoute(rt)),
      mk("Delete","ghost danger",()=>del(rt.key)),
    );
    tb.appendChild(tr);
  }
}

async function load() {
  const r = await api("GET","/routes");
  if (r.status===401||r.status===403) { showLogin("Invalid token."); return; }
  if (!r.ok) { toast("Failed to load"); return; }
  showApp();
  render(r.data.routes, r.data);
}

$("loginBtn").onclick = () => { sessionStorage.setItem(KEY, $("token").value.trim()); $("loginErr").textContent=""; load(); };
$("token").addEventListener("keydown", e=>{ if(e.key==="Enter") $("loginBtn").click(); });

if (token()) load(); else showLogin("");
</script>
</body>
</html>`;
