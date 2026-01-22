
function applyAdminOnlyVisibility(){
  try{
    const admin = isAdmin();
    qa(".adminOnly").forEach(el=>{ el.style.display = admin ? "" : "none"; });
  }catch(e){}
}


function appendHistPoint(kind, id, p){
  const h = getHist();
  const key = (kind==="datalogger") ? "dl" : "c";
  h[key] = h[key] || {};
  h[key][id] = h[key][id] || [];
  h[key][id].push({ t: p.t, level_pct: p.level_pct, flow_lps: p.flow_lps, raw: p.raw||null });
  if(h[key][id].length>2000) h[key][id]=h[key][id].slice(-2000);
  save(LS.hist, h);
}


function generateDemoMeteoSeries(seedStr, days=30){
  const seed=(seedStr||"meteo");
  let h=2166136261;
  for(let i=0;i<seed.length;i++){ h^=seed.charCodeAt(i); h=Math.imul(h,16777619); }
  const rand=()=>{ h^=h<<13; h^=h>>>17; h^=h<<5; return ((h>>>0)/4294967296); };
  const now=Date.now();
  const step = 3 * 60 * 60 * 1000; // 3h
  const n = Math.max(80, Math.floor((days*24)/3));
  const out=[];
  for(let i=n-1;i>=0;i--){
    const t = now - i*step;
    // rainfall bursts
    let mm = 0;
    if(rand()<0.18){
      mm = Math.max(0, (rand()*8) * (rand()<0.35 ? 2.2 : 1));
    }
    out.push({ t, rain_mm: Number(mm.toFixed(2)) });
  }
  return out;
}




function seedFallbackMeteoSeries(seedStr, days=365){
  // Generates daily precipitation (mm) with wet/dry spells.
  let h = 2166136261;
  const s = seedStr||"meteo";
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rand=()=>{ h ^= h<<13; h ^= h>>>17; h ^= h<<5; return ((h>>>0)/4294967296); };

  const out=[];
  const now = new Date();
  // start from midnight today - days
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (days-1));

  let wetness = rand(); // 0..1
  for(let d=0; d<days; d++){
    const day = new Date(start.getTime() + d*86400000);
    // Markov-like wet/dry regime
    if(rand() < 0.12) wetness = 1 - wetness; // regime change
    const isWet = wetness > 0.5 ? (rand() < 0.72) : (rand() < 0.22);
    let mm = 0;
    if(isWet){
      // rain intensity
      mm = Math.max(0, (rand()**0.35) * (8 + rand()*22)); // skew to heavier some days
      // occasional storms
      if(rand() < 0.07) mm += 15 + rand()*35;
    }else{
      mm = 0;
    }
    out.push({ t: day.getTime(), rain_mm: Number(mm.toFixed(2)) });
  }
  return out;
}

async function ensureMeteoForLoc(loc, lat=null, lng=null){
  // Returns array [{t(ms), rain_mm}] for last ~1 year; caches in localStorage.
  const key=(loc||"").trim() || (lat!=null && lng!=null ? `@${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}` : "DEFAULT");
  const store=getMeteoHistStore();
  store.locs = store.locs || {};
  const existing = store.locs[key];
  if(Array.isArray(existing) && existing.length>=120) return existing;

  // try fetch from Open-Meteo (daily precip) using coords; fallback to synthetic
  let series = null;
  try{
    let la=lat, lo=lng;
    if((la==null || lo==null) && loc){
      // try geocode via Open-Meteo geocoding
      const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(loc)}&count=1&language=pt&format=json`);
      if(g.ok){
        const gj=await g.json();
        if(gj && gj.results && gj.results[0]){ la=gj.results[0].latitude; lo=gj.results[0].longitude; }
      }
    }
    if(la==null || lo==null){
      // default Lisbon
      la = 38.7223; lo = -9.1393;
    }
    const end = new Date();
    const start = new Date(end.getTime() - 365*86400000);
    const sISO = start.toISOString().slice(0,10);
    const eISO = end.toISOString().slice(0,10);
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${la}&longitude=${lo}&start_date=${sISO}&end_date=${eISO}&daily=precipitation_sum&timezone=UTC`;
    const r = await fetch(url);
    if(r.ok){
      const j = await r.json();
      if(j && j.daily && j.daily.time && j.daily.precipitation_sum){
        series = j.daily.time.map((t,i)=>({ t: Date.parse(t+"T00:00:00Z"), rain_mm: Number(j.daily.precipitation_sum[i]||0) }));
      }
    }
  }catch(e){}
  if(!Array.isArray(series) || series.length<60){
    series = seedFallbackMeteoSeries(key, 365);
  }

  store.locs[key]=series;
  try{ localStorage.setItem("adngest_meteo_hist_v1", JSON.stringify(store)); }catch(e){}
  return series;
}

function getMeteoHistStore(){
  try{ return JSON.parse(localStorage.getItem("adngest_meteo_hist_v1")||"{}"); }catch(e){ return {}; }
}
function getMeteoSeriesForLoc(loc){
  const store = getMeteoHistStore();
  const key = (loc||"").trim();
  if(store && store.locs){
    if(key && store.locs[key] && Array.isArray(store.locs[key])) return store.locs[key];
    const ks = Object.keys(store.locs||{});
    if(ks.length && Array.isArray(store.locs[ks[0]])) return store.locs[ks[0]];
  }
  return [];
}


/**
 * Generate a telemetry series whose behavior correlates with rainfall (mm).
 * - More rain => higher "wetness index" => higher level and flow.
 * - Dry streak => wetness decays => level/flow slowly drop.
 * Deterministic given meteo array + seed string.
 */
function generateCorrelatedSeries(seedStr, meteoArr, days=30){
  const seed = (seedStr||"demo");
  let h = 2166136261;
  for(let i=0;i<seed.length;i++){ h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rand = ()=>{ h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h>>>0)/4294967296); };

  const now = Date.now();
  const step = 6 * 60 * 60 * 1000; // 6h
  const n = Math.max(40, Math.floor((days*24)/6));
  const out=[];

  // Build rainfall lookup by bucketed timestamp
  const rainByBucket = {};
  try{
    (meteoArr||[]).forEach(p=>{
      const t = (typeof p.t==="number") ? p.t : Date.parse(p.t);
      const b = Math.floor(t/step)*step;
      const mm = Number(p.rain_mm ?? p.mm ?? 0) || 0;
      rainByBucket[b] = (rainByBucket[b]||0) + mm;
    });
  }catch(e){}

  // Parameters: tune to look realistic but bounded
  const baseLevel = 28 + rand()*18;     // 28..46
  const baseFlow  = 1.2 + rand()*2.8;   // 1.2..4.0
  const kLevel = 2.2 + rand()*1.4;      // multiplier on wetness
  const kFlow  = 0.55 + rand()*0.35;    // multiplier on wetness
  const evap   = 0.08 + rand()*0.05;    // dry decay per step (6h)

  let wet = 0; // wetness index
  for(let i=n-1;i>=0;i--){
    const t = now - i*step;
    const b = Math.floor(t/step)*step;
    const rain = rainByBucket[b] || 0;

    // Update wetness: add rain, then decay. Rain boosts more when persistent.
    wet += rain * 0.9;
    wet *= (1 - evap);
    // clamp wetness so it doesn't blow up
    wet = Math.min(45, Math.max(0, wet));

    // Noise & small diurnal variation
    const noiseL = (rand()-0.5)*3.5;
    const noiseF = (rand()-0.5)*0.8;
    const diurnal = Math.sin((t/86400000)*Math.PI*2) * (1.2 + rand()*0.6);

    // Level and flow derived from wetness
    let lvl = baseLevel + wet*kLevel + diurnal + noiseL;
    let flow = baseFlow + wet*kFlow + Math.max(0, rain*0.12) + noiseF;

    // Boundaries
    lvl = Math.min(99, Math.max(1, lvl));
    flow = Math.max(0, flow);

    out.push({ t, level_pct: Number(lvl.toFixed(1)), flow_lps: Number(flow.toFixed(2)), rain_mm: Number(rain.toFixed(2)) });
  }
  return out;
}

function generateDemoSeries(seedStr, days=30){
  // Deterministic pseudo-random demo data (last N days, 6h step)
  const seed = (seedStr||"demo");
  let h = 2166136261;
  for(let i=0;i<seed.length;i++){ h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rand = ()=>{
    // xorshift32
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h>>>0) / 4294967296);
  };

  const now = Date.now();
  const step = 6 * 60 * 60 * 1000; // 6 hours
  const n = Math.max(20, Math.floor((days*24)/6)); // ~120 points for 30 days
  const out=[];
  for(let i=n-1;i>=0;i--){
    const t = now - i*step;
    const baseLvl = 40 + rand()*50;              // 40..90
    const spike = (rand() < 0.08) ? rand()*20:0; // occasional spike
    const lvl = Math.min(99, Math.max(5, baseLvl + spike));
    const flow = Math.max(0, (rand()*18) + (lvl/100)*4); // 0..~22
    out.push({ t, level_pct: Number(lvl.toFixed(1)), flow_lps: Number(flow.toFixed(2)) });
  }
  return out;
}


function ensureDashPickDelegate(){
  if(document.body && !document.body._dashPickDelegate){
    document.body.addEventListener("click", (ev)=>{
      const el = ev.target.closest && ev.target.closest("[data-dashpick-kind]");
      if(!el) return;
      ev.preventDefault();
      const kind = el.getAttribute("data-dashpick-kind");
      const id = el.getAttribute("data-dashpick-id");
      const name = el.getAttribute("data-dashpick-name") || "";
      selectDashboardDevice(kind, id, name);
    });
    document.body._dashPickDelegate = true;
  }
}


async function withBtnBusy(btn, fn){
  if(!btn) return fn();
  const oldTxt = btn.textContent;
  try{
    btn.disabled = true;
    btn.textContent = "A atualizar...";
    return await fn();
  }finally{
    btn.disabled = false;
    btn.textContent = oldTxt;
  }
}


function createHtmlLegend(chart, containerId){
    const container = document.getElementById(containerId);
    if(!container) return;
    container.innerHTML = '';
    const ul = document.createElement('ul');
    ul.className = 'chart-html-legend';
    chart.data.datasets.forEach(ds=>{
        const li = document.createElement('li');
        const box = document.createElement('span');
        box.style.background = ds.borderColor;
        box.className = 'box';
        li.appendChild(box);
        li.appendChild(document.createTextNode(ds.label));
        ul.appendChild(li);
    });
    container.appendChild(ul);
}

/* ADNGest v30 — single-page web app (standalone)
   - Login + roles/perms (Admin/Colaborador/Convidado)
   - Users CRUD + audit log
   - Data Logger´s (56) + Caudalímetros (76) simulated across Vale do Ave municipalities & rivers
   - Leaflet map with layers, fullscreen, icons, color status, flow (caudal) display
   - Weather (7 days + precipitation metrics) for Guimarães default, selectable any PT city
   - Historical data per equipment + aggregation minute/hour/day/week/month/year, export CSV/PDF, admin delete
   - Maintenance + Inspections (with photos) per equipment (admin-only edit)
   - SCADA hooks: applyScadaUpdate(kind, payload) ready for external server integration
*/

/* ---------- Storage keys ---------- */
const LS = {
  users: "adngest_users_v30",
  session: "adngest_session_v30",
  config: "adngest_config_v30",
  dl: "adngest_dataloggers_v30",
  c: "adngest_caudalimetros_v30",
  hist: "adngest_hist_v30",      // {dl:{id:[...]}, c:{id:[...]}, meteo:[...]}
  meteoCache: "adngest_meteo_cache_v30", // { "<place>": {name,lat,lng,updatedAt, hourly:{time[],precip[]}} }
  audit: "adngest_audit_v30",    // [{t,user,action,detail}]
  online: "adngest_online_v30"   // { "email": {email,name,role,sessionId,lastSeen} }
,
  sb:"adngest_supabase_cfg_v1",
  collector:"adngest_collector_cfg_v1"
,
  seed:"adngest_seed_flags_v1"
};

const ADMIN_EMAIL = "miguelteixeira1985@gmail.com";
const ADMIN_PASS  = "Santiau+10+18";

const ROLES = ["Administrador","Colaborador","Convidado"];
const PERMS = {
  VIEW: "view",
  EDIT: "edit",
  ADMIN: "admin",
  DELETE: "delete"
};

const PERM_OPTIONS = [
  { value: "dash_view", label: "Ver Dashboard" },
  { value: "dl_view", label: "Ver Data Logger´s" },
  { value: "dl_edit", label: "Editar Data Logger´s" },
  { value: "c_view", label: "Ver Caudalímetros" },
  { value: "c_edit", label: "Editar Caudalímetros" },
  { value: "hist_view", label: "Ver Histórico" },
  { value: "histutil_view", label: "Ver Histórico Utilizadores" },
  { value: "hist_delete", label: "Apagar Histórico" },
  { value: "users_view", label: "Ver Utilizadores" },
  { value: "users_manage", label: "Gerir Utilizadores" },
  { value: "cfg_view", label: "Ver Configurações" },
  { value: "cfg_edit", label: "Editar Configurações" },
  { value: "mnt_view", label: "Ver Manutenções" },
  { value: "mnt_edit", label: "Editar Manutenções" },
  { value: "insp_view", label: "Ver Inspeções" },
  { value: "insp_edit", label: "Editar Inspeções" },
  // Ferramentas (acesso granular)
  { value: "tools_roles", label: "Ferramentas: Permissões (roles)" },
  { value: "tools_api", label: "Ferramentas: Integrações (API)" },
  // Core flags used by the app (do not remove)
  { value: PERMS.VIEW, label: "Acesso base (VIEW)" },
  { value: PERMS.EDIT, label: "Edição global (EDIT)" },
  { value: PERMS.DELETE, label: "Eliminar (DELETE)" },
  { value: PERMS.ADMIN, label: "Admin (ADMIN)" }
];


const PT_CITY_SUGGESTIONS = [
  "Guimarães","Vizela","Vila Nova de Famalicão","Santo Tirso","Trofa","Porto","Braga","Lisboa","Coimbra","Aveiro",
  "Viana do Castelo","Viseu","Leiria","Setúbal","Faro","Évora","Beja","Bragança","Castelo Branco","Guarda",
  "Vila Real","Portalegre","Santarém","Ponta Delgada","Angra do Heroísmo","Funchal"
];

const MUNICIPIO_CENTERS = {
  "Guimarães": [41.4444, -8.2962],
  "Vizela": [41.3902, -8.2634],
  "Vila Nova de Famalicão": [41.4079, -8.5198],
  "Santo Tirso": [41.3410, -8.4770],
  "Trofa": [41.3400, -8.5600]
};

const DEFAULT_MUNICIPIOS = Object.keys(MUNICIPIO_CENTERS);
const DEFAULT_RIOS = ["Interceptor do Rio Ave","Rio Ave","Rio Selho","Rio Vizela","Rio Pele","Rio Pelhe","Rio Nespereira"];

/* ---------- Helpers ---------- */
function $(id){ return document.getElementById(id); }
function q(sel, root=document){ return root.querySelector(sel); }
function qa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

function save(key, obj){ localStorage.setItem(key, JSON.stringify(obj)); }

function getSbCfg(){ return load(LS.sb, { url:"https://bdewsbygmbwzolrtxsph.supabase.co", anon:"sb_publishable_UQVfHkHZXKmctrQWhzA8Dg_T28mHg6R", devices:"devices", telemetry:"telemetry", meteo:"meteo_hourly" }); }
function setSbCfg(v){ save(LS.sb, v); }
function getCollectorCfg(){ return load(LS.collector, { url:"", token:"" }); }
function setCollectorCfg(v){ save(LS.collector, v); }
function sbEnabled(){ const c=getSbCfg(); return !!(c.url && c.anon); }


async function sbAuthPasswordLogin(email, password){
  const sb=getSbCfg();
  const url = sb.url.replace(/\/$/,"") + "/auth/v1/token?grant_type=password";
  const headers = { "apikey": sb.anon, "Content-Type":"application/json" };
  const res = await fetch(url, { method:"POST", headers, body: JSON.stringify({ email, password }) });
  if(!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error("Auth error: " + res.status + " " + t);
  }
  return await res.json(); // {access_token, refresh_token, user...}
}

async function sbAuthSignUp(email, password, data){
  const sb=getSbCfg();
  const url = sb.url.replace(/\/$/,"") + "/auth/v1/signup";
  const headers = { "apikey": sb.anon, "Content-Type":"application/json" };
  const payload = { email, password };
  if(data) payload.data = data;
  const res = await fetch(url, { method:"POST", headers, body: JSON.stringify(payload) });
  if(!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error("Signup error: " + res.status + " " + t);
  }
  return await res.json();
}

async function sbRequest(path, method="GET", body=null){
  const cfg=getSbCfg();
  const url = cfg.url.replace(/\/$/,"") + "/rest/v1/" + path.replace(/^\//,"");
  const headers = {
    "apikey": cfg.anon,
    "Authorization": "Bearer " + cfg.anon,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
  };
  const res = await fetch(url, { method, headers, body: body?JSON.stringify(body):undefined });
  if(!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error("Supabase error: " + res.status + " " + t);
  }
  if(res.status===204) return null;
  return await res.json();
}

// Convenience helpers for Supabase PostgREST (avoid supabase-js dependency)
function sbQ(obj){
  return Object.entries(obj).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
async function sbSelect(table, { select="*", order=null, limit=null, eq=null }={}){
  const q = { select };
  if(order) q.order = order;
  if(limit!=null) q.limit = String(limit);
  if(eq){
    for(const [k,v] of Object.entries(eq)) q[`${k}`] = `eq.${v}`;
  }
  return await sbRequest(`${table}?${sbQ(q)}`, "GET");
}
async function sbInsert(table, row){
  return await sbRequest(`${table}`, "POST", row);
}
async function sbUpdate(table, patch, eq){
  const q = {};
  for(const [k,v] of Object.entries(eq||{})) q[k] = `eq.${v}`;
  return await sbRequest(`${table}?${sbQ(q)}`, "PATCH", patch);
}
async function sbDelete(table, eq){
  const q = {};
  for(const [k,v] of Object.entries(eq||{})) q[k] = `eq.${v}`;
  return await sbRequest(`${table}?${sbQ(q)}`, "DELETE");
}
function toastErr(msg){
  console.error(msg);
  try{
    triggerAlarm({ title:"Erro", body:String(msg||"Erro"), severity:"danger" });
  }catch(e){
    alert(String(msg||"Erro"));
  }
}

// Detect common Supabase PostgREST schema-cache errors (missing table / not exposed)
function sbIsMissingTableError(err){
  const m = String(err?.message || err || "");
  return m.includes("PGRST205") || m.includes("Could not find the table") || m.includes("schema cache");
}

function sbWarnMissingTableOnce(table){
  const k = "adngest_sb_missing_tables_v1";
  let seen = {};
  try{ seen = JSON.parse(localStorage.getItem(k)||"{}"); }catch(e){ seen={}; }
  if(seen[table]) return;
  seen[table] = true;
  try{ localStorage.setItem(k, JSON.stringify(seen)); }catch(e){}
  toastErr(`Tabela Supabase em falta: ${table}. Execute o ficheiro SUPABASE_SCHEMA.sql na Supabase e depois faça Reload do schema cache (Supabase Dashboard > API).`);
}

async function sbUpsertDevice(dev){
  const cfg=getSbCfg();
  const table = cfg.devices || "devices";
  const payload = {
    id: String(dev.id),
    type: dev.type || "",
    name: dev.name || "",
    lat: dev.lat ?? null,
    lng: dev.lng ?? null,
    municipio: dev.municipio ?? "",
    source_type: dev.source_type ?? "manual",
    external_id: dev.external_id ?? "",
    scada_url: dev.scada_url ?? "",
    collector_url: dev.collector_url ?? ""
  };
  await sbRequest(`${table}?on_conflict=id`, "POST", payload);
}

async function sbInsertTelemetryPoint(kind, id, p){
  const cfg=getSbCfg();
  const table = cfg.telemetry || "telemetry";
  const payload = {
    device_id: String(id),
    device_type: String(kind),
    ts: new Date(p.t || Date.now()).toISOString(),
    level_pct: p.level_pct ?? null,
    flow_m3: (p.flow_m3 ?? p.flow_lps ?? null),
    raw: p.raw ?? null
  };
  await sbRequest(table, "POST", payload);
}


// Bulk seed helper (used to backfill 1 year of demo data into Supabase once)
const __SB_SEEDED_KEY = "adngest_sb_seeded_v1";
function _sbSeededGet(){
  try{ return JSON.parse(localStorage.getItem(__SB_SEEDED_KEY)||"{}"); }catch(e){ return {}; }
}
function _sbSeededSet(obj){
  try{ localStorage.setItem(__SB_SEEDED_KEY, JSON.stringify(obj||{})); }catch(e){}
}
async function sbHasAnyTelemetry(kind, id){
  try{
    const cfg=getSbCfg(); const table=cfg.telemetry||"telemetry";
    const q = `${table}?select=ts&device_id=eq.${encodeURIComponent(String(id))}&device_type=eq.${encodeURIComponent(String(kind))}&order=ts.desc&limit=1`;
    const rows = await sbRequest(q, "GET");
    return Array.isArray(rows) && rows.length>0;
  }catch(e){
    return false;
  }
}
async function sbInsertTelemetryBatch(kind, id, points){
  const cfg=getSbCfg();
  const table = cfg.telemetry || "telemetry";
  const arr=(points||[]).map(p=>({
    device_id: String(id),
    device_type: String(kind),
    ts: new Date(p.t || Date.now()).toISOString(),
    level_pct: p.level_pct ?? null,
    flow_m3: (p.flow_m3 ?? p.flow_lps ?? null),
    raw: p.raw ?? null
  }));
  if(!arr.length) return;
  // chunked inserts to avoid payload limits
  const chunk=500;
  for(let i=0;i<arr.length;i+=chunk){
    const part=arr.slice(i,i+chunk);
    await sbRequest(table, "POST", part);
  }
}
async function sbSeedTelemetryOnceFromLocal(kind, id, points){
  if(!sbEnabled()) return;
  const seed=_sbSeededGet();
  const k=`tele:${kind}:${id}`;
  if(seed[k]) return;
  // only seed if remote is empty
  const has = await sbHasAnyTelemetry(kind, id);
  if(has){ seed[k]=true; _sbSeededSet(seed); return; }
  await sbInsertTelemetryBatch(kind, id, points);
  seed[k]=true;
  _sbSeededSet(seed);
}

async function sbInsertMeteoPoint(locKey, p){
  const cfg=getSbCfg();
  const table = cfg.meteo || "meteo_hourly";
  const payload = {
    loc_key: String(locKey||""),
    ts: new Date(p.t || Date.now()).toISOString(),
    precipitation_mm: (p.p_mm_h ?? p.precip_mm ?? p.rain_mm ?? null),
    temp_c: (p.t_c ?? null),
    lat: (p.lat ?? null),
    lng: (p.lng ?? null),
    name: (p.name ?? null)
  };
  await sbRequest(table, "POST", payload);
}

function _toIso(ms){ return new Date(ms).toISOString(); }

async function sbDeleteTelemetryByRange(kind, id, start_ms, end_ms){
  const cfg=getSbCfg();
  const table = cfg.telemetry || "telemetry";
  const sIso = _toIso(Number(start_ms));
  const eIso = _toIso(Number(end_ms));
  const q = `${table}?device_id=eq.${encodeURIComponent(String(id))}&device_type=eq.${encodeURIComponent(String(kind))}&ts=gte.${encodeURIComponent(sIso)}&ts=lt.${encodeURIComponent(eIso)}`;
  await sbRequest(q, "DELETE");
}

async function sbDeleteAllTelemetryForDevice(kind, id){
  const cfg=getSbCfg();
  const table = cfg.telemetry || "telemetry";
  const q = `${table}?device_id=eq.${encodeURIComponent(String(id))}&device_type=eq.${encodeURIComponent(String(kind))}`;
  await sbRequest(q, "DELETE");
}

async function sbDeleteMeteoByRange(locKey, start_ms, end_ms){
  const cfg=getSbCfg();
  const table = cfg.meteo || "meteo_hourly";
  const sIso = _toIso(Number(start_ms));
  const eIso = _toIso(Number(end_ms));
  const q = `${table}?loc_key=eq.${encodeURIComponent(String(locKey))}&ts=gte.${encodeURIComponent(sIso)}&ts=lt.${encodeURIComponent(eIso)}`;
  await sbRequest(q, "DELETE");
}

async function sbDeleteAllMeteo(locKey){
  const cfg=getSbCfg();
  const table = cfg.meteo || "meteo_hourly";
  const q = `${table}?loc_key=eq.${encodeURIComponent(String(locKey))}`;
  await sbRequest(q, "DELETE");
}

async function collectorPull(kind, dev){
  const cfg=getCollectorCfg();
  const base = (dev.collector_url && String(dev.collector_url).trim()) ? String(dev.collector_url).trim() : (cfg.url||"").trim();
  if(!base) throw new Error("Collector URL não configurado.");
  const token = (cfg.token||"").trim();
  const url = base.replace(/\/$/,"") + "/pull";
  const headers = { "Content-Type":"application/json" };
  if(token) headers["Authorization"]=token;
  const body = {
    kind,
    device_id: String(dev.id),
    source_type: dev.source_type || "",
    external_id: dev.external_id || "",
    scada_url: dev.scada_url || ""
  };
  const res = await fetch(url, { method:"POST", headers, body: JSON.stringify(body) });
  if(!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error("Collector error: " + res.status + " " + t);
  }
  return await res.json();
}


async function sbFetchDevices(){
  const cfg=getSbCfg(); const table=cfg.devices||"devices";
  return await sbRequest(`${table}?select=*`);
}

async function sbFetchTelemetry(device_id, limit=180){
  const cfg=getSbCfg(); const table=cfg.telemetry||"telemetry";
  return await sbRequest(`${table}?select=ts,level_pct,flow_m3,raw&device_id=eq.${encodeURIComponent(String(device_id))}&order=ts.desc&limit=${limit}`);
}

async function sbSyncLocalDevicesToSupabase(){
  const dls=getDL().map(d=>({ ...d, type:"datalogger" }));
  const cs=getC().map(c=>({ ...c, type:"caudalimetro" }));
  for(const dev of [...dls,...cs]){
    try{ await sbUpsertDevice(dev); }catch(e){}
  }
}

async function sbLoadDevicesToLocal(){
  const rows = await sbFetchDevices();
  const dls=[]; const cs=[];
  (rows||[]).forEach(r=>{
    const base={
      id: r.id,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      municipio: r.municipio||"",
      source_type: r.source_type||"manual",
      external_id: r.external_id||"",
      scada_url: r.scada_url||"",
      collector_url: r.collector_url||""
    };
    if(r.type==="datalogger"){ dls.push({ ...base, minLevel:0, maxLevel:100, minFlow:0, maxFlow:0 }); }
    else if(r.type==="caudalimetro"){ cs.push({ ...base }); }
  });
  if(dls.length) setDL(dls);
  if(cs.length) setC(cs);
  try{ ensureSeedSixMonths(); }catch(e){}
  return {dls,cs};
}

async function sbLoadTelemetryIntoHist(device_id, kind){
  const rows = await sbFetchTelemetry(device_id, 200);
  const pts = (rows||[]).map(r=>{
    const t = Date.parse(r.ts);
    return { t, level_pct: r.level_pct ?? null, flow_lps: r.flow_m3 ?? null, raw: r.raw ?? null };
  }).reverse();

  const h=getHist();
  const key=(kind==="datalogger")?"dl":"c";
  h[key]=h[key]||{};
  const existing = h[key][device_id] || [];

  // Important: if Supabase has no telemetry, DO NOT wipe local/demo data.
  if(pts.length>0){
    h[key][device_id]=pts;
    save(LS.hist, h);
    return pts;
  }
  return existing;
}

let __sbBootstrapped=false;
async function sbBootstrap(){
  if(__sbBootstrapped) return;
  __sbBootstrapped=true;
  if(!sbEnabled()) return;
  try{
    const rows = await sbFetchDevices();
    if(Array.isArray(rows) && rows.length){
      await sbLoadDevicesToLocal();
      try{ ensureHistoricoData(); }catch(e){}
      try{ renderHistorico(); }catch(e){}
      try{ renderDashboard(); }catch(e){}
    }else{
      await sbSyncLocalDevicesToSupabase();
      try{ ensureHistoricoData(); }catch(e){}
      try{ renderHistorico(); }catch(e){}
    }
  }catch(e){}

  try{ ensureSeedSixMonths(); }catch(e){}
}

const __sbLoadedTelemetry = {}; // key => true
function sbEnsureTelemetry(kind,id, after){
  if(!sbEnabled()) return false;
  const k = `${kind}:${id}`;
  if(__sbLoadedTelemetry[k]) return false;
  __sbLoadedTelemetry[k]=true;
  sbLoadTelemetryIntoHist(id, kind).then((pts)=>{ if(!pts || pts.length===0){ __sbLoadedTelemetry[k]=false; } try{ after && after(); }catch(e){} }).catch(()=>{ __sbLoadedTelemetry[k]=false; });
  return true;
}




function load(key, fallback){
  try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch{ return fallback; }
}
function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m]));
}
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function n2(v){ const x=Number(v); return Number.isFinite(x) ? x : NaN; }
function nowISO(){ return new Date().toISOString(); }
function fmtDT(iso){ try{ return new Date(iso).toLocaleString("pt-PT"); }catch{ return String(iso); } }
function uuid(){ return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2); }

/* ---------- Audit log ---------- */
function fmtDT(iso){
  try{
    const d=new Date(iso);
    if(isNaN(d.getTime())) return iso||"";
    return d.toLocaleString();
  }catch(e){ return iso||""; }
}
function audit(action, detail="", meta=null){
  const u=currentUser();
  const iso=nowISO();
  const m = meta||{};
  const labelMap = {
    LOGIN: "Entrou na aplicação (login efetuado)",
    LOGOUT: "Saiu da aplicação (logout)",
    NAV: "Navegou na aplicação (mudança de separador)",
    ALERT: "Recebeu um alerta na aplicação",
    DEVICE_OPEN: "Abriu um equipamento",
    DEVICE_EDIT: "Editou um equipamento (alteração de dados)",
    DEVICE_ADD: "Adicionou um novo equipamento",
    DEVICE_DELETE: "Eliminou um equipamento",
    // Ações atualmente emitidas no código (compatibilidade)
    EDIT_DEVICE: "Editou um equipamento (alteração de dados)",
    ADD_DEVICE: "Adicionou um novo equipamento",
    DELETE_DEVICE: "Eliminou um equipamento",
    EDIT_CELL: "Editou um campo (edição inline)",
    TOGGLE_EDIT: "Ativou/desativou modo de edição",
    BATTERY: "Adicionou registo de bateria",
    MAINTENANCE: "Adicionou registo de manutenção",
    INSPECTION: "Adicionou registo de inspeção",
    DELETE_LOG: "Eliminou um registo (bateria/manutenção)",
    DELETE_INSPECTION: "Eliminou um registo de inspeção",
    USERS_ADD: "Adicionou um utilizador",
    USERS_EDIT: "Editou um utilizador",
    USERS_DELETE: "Eliminou um utilizador",
    ADD_USER: "Adicionou um utilizador",
    EDIT_USER: "Editou um utilizador",
    DELETE_USER: "Eliminou um utilizador",
    CFG_SAVE: "Guardou configurações",
    CFG_ADD_MUNICIPIO: "Adicionou município",
    CFG_DEL_MUNICIPIO: "Eliminou município",
    CFG_ADD_RIO: "Adicionou rio/interceptor",
    CFG_DEL_RIO: "Eliminou rio/interceptor",
    EXPORT_CSV: "Exportou CSV",
    EXPORT_PDF: "Exportou um relatório em PDF",
    EXPORT_XLSX: "Exportou um relatório em Excel/CSV",
    EXPORT_KML: "Exportou um ficheiro KML",
    HIST_DELETE_ONE: "Eliminou um registo do histórico",
    HIST_DELETE_ALL: "Eliminou o histórico completo"
  };
  if(!m.exact){
    const lbl = labelMap[action] || action;
    m.exact = detail ? `${lbl} — ${detail}` : lbl;
  }
  const entry={ ts: iso, user: u ? (u.email||u.name||"—") : "—", action, detail, meta: m };
  const list=load(LS.audit, []);
  list.push(entry);
  if(list.length>20000) list.splice(0, list.length-20000);
  save(LS.audit, list);

  // Best-effort persist to Supabase (Histórico Utilizadores).
  // Never blocks UI. If Supabase is not configured or the table does not exist, we silently ignore.
  try{
    const cfg = getSbCfg();
    if(cfg && cfg.url && cfg.anon){
      // Use a stable schema so we can query later.
      const row = {
        ts: entry.ts,
        user: entry.user,
        action: entry.action,
        detail: entry.detail,
        meta: entry.meta
      };
      // Fire-and-forget.
      sbInsert((cfg.audit_log||"audit_log"), row).catch(()=>{});
    }
  }catch(e){}
}


function describeAuditEntry(e){
  if(!e) return "";
  const meta = e.meta || {};
  const user = e.user || "—";
  const detail = e.detail || "";
  const action = e.action || "";
  const dt = e.ts ? fmtDT(e.ts) : "";

  const kindLabel = (k)=>{
    if(k==="datalogger") return "Data Logger";
    if(k==="caudal") return "Caudalímetro";
    return k||"equipamento";
  };

  // Try to extract name from detail like "datalogger: X" etc.
  const extracted = (()=>{
    const m = String(detail).match(/^(datalogger|caudal)\s*:\s*(.+)$/i);
    if(m) return { kind: m[1].toLowerCase(), name: m[2] };
    return null;
  })();

  const name = meta.name || extracted?.name || meta.deviceName || meta.target || meta.id || "";
  const kind = meta.kind || extracted?.kind || meta.deviceKind || "";
  const tab = meta.tab || meta.tabId || meta.section || "";
  const fmt = meta.format || meta.file || "";
  const targetUser = meta.targetEmail || meta.email || meta.targetUser || "";
  const msg = meta.message || meta.msg || "";
  const what = meta.what || meta.item || "";

  switch(action){
    case "LOGIN":
      return `${user} entrou na aplicação${detail?` (${detail})`:""}.`;
    case "LOGOUT":
      return `${user} saiu da aplicação.`;
    case "NAV":
      return `${user} navegou para o separador ${tab?`"${tab}"`:"(não especificado)"}.`;
    case "ALERT":
      return `${user} recebeu um alerta${msg?`: "${msg}"`:""}${detail?` (${detail})`:""}.`;
    case "DEVICE_OPEN":
      return `${user} abriu o ${kindLabel(kind)} ${name?`"${name}"`:""}${detail && !name?` (${detail})`:""}.`;
    case "DEVICE_ADD":
      return `${user} adicionou um novo ${kindLabel(kind)} ${name?`"${name}"`:""}${detail?` (${detail})`:""}.`;
    case "DEVICE_EDIT":
      return `${user} editou o ${kindLabel(kind)} ${name?`"${name}"`:""}${detail?` — ${detail}`:""}.`;
    case "DEVICE_DELETE":
      return `${user} eliminou o ${kindLabel(kind)} ${name?`"${name}"`:""}${detail?` (${detail})`:""}.`;
    case "USERS_ADD":
      return `${user} adicionou o utilizador ${targetUser?`"${targetUser}"`:""}${detail?` (${detail})`:""}.`;
    case "USERS_EDIT":
      return `${user} editou o utilizador ${targetUser?`"${targetUser}"`:""}${detail?` — ${detail}`:""}.`;
    case "USERS_DELETE":
      return `${user} eliminou o utilizador ${targetUser?`"${targetUser}"`:""}${detail?` (${detail})`:""}.`;
    case "EXPORT_PDF":
      return `${user} exportou um relatório em PDF${name?` do ${kindLabel(kind)} "${name}"`:""}${detail?` (${detail})`:""}.`;
    case "EXPORT_XLSX":
      return `${user} exportou um relatório em Excel/CSV${name?` do ${kindLabel(kind)} "${name}"`:""}${detail?` (${detail})`:""}.`;
    case "EXPORT_KML":
      return `${user} exportou um ficheiro KML${detail?` (${detail})`:""}.`;
    case "HIST_DELETE_ONE":
      return `${user} eliminou um registo do histórico${what?`: ${what}`:""}${detail?` (${detail})`:""}.`;
    case "HIST_DELETE_ALL":
      return `${user} eliminou o histórico completo${detail?` (${detail})`:""}.`;
    default:
      // fallback to stored exact if present, else assemble
      if(meta.exact) return meta.exact;
      return `${user} executou a ação "${action}"${detail?`: ${detail}`:""}.`;
  }
}



/* ---------- Auth & Users ---------- */
function ensureBootstrap(){
  // users
  let users = load(LS.users, null);
  if(!Array.isArray(users)){
    users = [];
  }
  const idx = users.findIndex(u => String(u.email||"").toLowerCase()===ADMIN_EMAIL.toLowerCase());
  const admin = {
    id: "u-admin",
    name: "Miguel Teixeira",
    email: ADMIN_EMAIL,
    phone: "",
    password: ADMIN_PASS,
    role: "Administrador",
    perms: PERM_OPTIONS.map(p=>p.value)
  };
  if(idx>=0) users[idx] = { ...users[idx], ...admin };
  else users.push(admin);
  save(LS.users, users);

  // config
  let cfg = load(LS.config, null);
  if(!cfg){
    cfg = {
      weatherLocation: { name:"Guimarães", lat:41.4444, lng:-8.2962 },
      municipios: [...DEFAULT_MUNICIPIOS],
      rios: [...DEFAULT_RIOS],
      alerts: {
        level_on: true,
        level: 90,
        flow_on: true,
        flow: 90,
        email: false,
        email_to: "",
        sms: false,
        sms_to: "",
        external_on: false,
        external_url: "",
        external_method: "POST",
        external_token: ""
      }
    };
    save(LS.config, cfg);
  }else{
    // migrate older "vale do ave" labels
    if(!cfg.weatherLocation || typeof cfg.weatherLocation.lat!=="number"){
      cfg.weatherLocation = { name:"Guimarães", lat:41.4444, lng:-8.2962 };
    }
    const n = String(cfg.weatherLocation.name||"").toLowerCase();
    if(!cfg.weatherLocation.name || n.includes("vale") || (n.includes("ave") && !n.includes("guimar"))){
      cfg.weatherLocation = { name:"Guimarães", lat:41.4444, lng:-8.2962 };
    }
    if(!Array.isArray(cfg.municipios) || !cfg.municipios.length) cfg.municipios=[...DEFAULT_MUNICIPIOS];
    if(!Array.isArray(cfg.rios) || !cfg.rios.length) cfg.rios=[...DEFAULT_RIOS];
    // Alerts / integrations migration
    if(!cfg.alerts) cfg.alerts = {};
    if(typeof cfg.alerts.level_on !== "boolean") cfg.alerts.level_on = true;
    if(typeof cfg.alerts.flow_on !== "boolean") cfg.alerts.flow_on = true;
    if(!Number.isFinite(Number(cfg.alerts.level))) cfg.alerts.level = 90;
    if(!Number.isFinite(Number(cfg.alerts.flow))) cfg.alerts.flow = 90;
    if(typeof cfg.alerts.email !== "boolean") cfg.alerts.email = false;
    if(typeof cfg.alerts.sms !== "boolean") cfg.alerts.sms = false;
    if(typeof cfg.alerts.email_to !== "string") cfg.alerts.email_to = "";
    if(typeof cfg.alerts.sms_to !== "string") cfg.alerts.sms_to = "";
    if(typeof cfg.alerts.external_on !== "boolean") cfg.alerts.external_on = false;
    if(typeof cfg.alerts.external_url !== "string") cfg.alerts.external_url = "";
    if(typeof cfg.alerts.external_method !== "string") cfg.alerts.external_method = "POST";
    if(typeof cfg.alerts.external_token !== "string") cfg.alerts.external_token = "";
    save(LS.config, cfg);
  }

  // devices
  if(!Array.isArray(load(LS.dl, null))) save(LS.dl, makeDevices("DL", 56));
  if(!Array.isArray(load(LS.c, null)))  save(LS.c, makeDevices("C", 76));

  // history structures
  const hist = load(LS.hist, null);
  if(!hist || typeof hist!=="object") save(LS.hist, { dl:{}, c:{}, meteo:[] });

  if(!Array.isArray(load(LS.audit, null))) save(LS.audit, []);
}

function currentUser(){
  const sess = load(LS.session, { email:null });
  if(!sess.email) return null;
  const users = load(LS.users, []);
  return users.find(u => String(u.email||"").toLowerCase()===String(sess.email||"").toLowerCase()) || null;
}
function isAdmin(){
  const u=currentUser();
  return u && u.role==="Administrador";
}
function hasPerm(p){
  const u=currentUser();
  if(!u) return false;
  if(u.role==="Administrador") return true;
  const perms=u.perms || [];
  return perms.includes(p) || perms.includes(PERMS.ADMIN);
}

// Kind-scoped edit permissions:
// - Global EDIT unlocks everything
// - dl_edit unlocks Data Logger´s
// - c_edit unlocks Caudalímetros
function canEditKind(kind){
  if(hasPerm(PERMS.EDIT)) return true;
  if(kind==="datalogger") return hasPerm("dl_edit");
  if(kind==="caudal") return hasPerm("c_edit");
  return false;
}

function showLoginError(msg){
  const el=$("loginError");
  if(!el){ alert(msg); return; }
  el.textContent = msg;
  el.classList.remove("hidden");
}
function clearLoginError(){
  const el=$("loginError");
  if(!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

function setAuthUI(logged){
  $("loginPage").classList.toggle("hidden", logged);
  $("appShell").classList.toggle("hidden", !logged);
}
function refreshHeader(){
  const u=currentUser();
  const name = u ? (u.name || u.email) : "—";
  $("currentUser").textContent = name;
  $("welcomeName").textContent = name;
  const sess = load(LS.session, { at:null });
  $("welcomeTime").textContent = sess.at ? fmtDT(sess.at) : "—";
}

function doLogin(){
  clearLoginError();
  ensureBootstrap();
  ensureSeedSixMonths();
  const email = ($("loginEmail").value || "").trim().toLowerCase();
  const pass  = ($("loginPass").value || "").trim();
  if(!email || !pass){ showLoginError("Preenche email e password."); return; }

  const cfg=getCfg();
  const wantSbAuth = sbEnabled(); // when Supabase configured, use auth by default

  if(wantSbAuth){
    // Supabase Auth (password grant)
    sbAuthPasswordLogin(email, pass).then(tok=>{
      try{
        localStorage.setItem("adngest_sb_token_v1", JSON.stringify({ access: tok.access_token, refresh: tok.refresh_token, at: Date.now(), email }));
      }catch(e){}
      const users = load(LS.users, []);
      let u = users.find(x => String(x.email||"").toLowerCase()===email);
      // If not in local users list, create a minimal viewer profile so they can enter
      if(!u){
        u = { id:"u-"+uuid(), name: email.split("@")[0], email, phone:"", password:"", role:"utilizador", perms:[PERMS.VIEW,"dash_view","dl_view","c_view","hist_view"] };
        users.push(u);
        save(LS.users, users);
      }
      save(LS.session, { email: u.email, at: nowISO(), supabase:true });
      audit("LOGIN", u.email);
      markOnline();
      setAuthUI(true);
      applyNavPerms();
      refreshHeader();
      try{ applyAdminOnlyVisibility(); }catch(e){}
      bootApp();
    }).catch(err=>{
      // fallback to local users if auth fails
      try{
        const users = load(LS.users, []);
        const u = users.find(x => String(x.email||"").toLowerCase()===email && String(x.password||"")===pass);
        if(!u){ showLoginError("Credenciais inválidas."); return; }
        save(LS.session, { email: u.email, at: nowISO() });
        audit("LOGIN", u.email);
        markOnline();
        setAuthUI(true);
        applyNavPerms();
        refreshHeader();
        try{ applyAdminOnlyVisibility(); }catch(e){}
        bootApp();
      }catch(e){
        showLoginError("Falha no login.");
      }
    });
    return;
  }

  const users = load(LS.users, []);
  const u = users.find(x => String(x.email||"").toLowerCase()===email && String(x.password||"")===pass);
  if(!u){ showLoginError("Credenciais inválidas."); return; }
  save(LS.session, { email: u.email, at: nowISO() });
  audit("LOGIN", u.email);
  markOnline();
  setAuthUI(true);
  applyNavPerms();
  refreshHeader();
  try{ applyAdminOnlyVisibility(); }catch(e){}
  bootApp();
}

function doLogout(){
  const u=currentUser();
  audit("LOGOUT", u?u.email:"—");
  markOffline();
  save(LS.session, { email:null, at:null });
  setAuthUI(false);
  refreshHeader();
  try{ applyNavPerms(); }catch(e){}
}

/* ---------- Online users (Admin visibility) ---------- */
function getOnlineMap(){
  return load(LS.online, {});
}
function saveOnlineMap(m){
  save(LS.online, m);
}
function ensureSessionId(){
  // One session id per login session.
  const s = load(LS.session, {});
  if(s && s.sid) return s.sid;
  const sid = Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
  if(s && s.email) save(LS.session, { ...s, sid });
  return sid;
}
function markOnline(){
  const u=currentUser();
  if(!u) return;
  const m=getOnlineMap();
  const sid=ensureSessionId();
  m[String(u.email||"").toLowerCase()] = {
    email: String(u.email||"").toLowerCase(),
    name: u.name || u.email,
    role: u.role || "",
    sessionId: sid,
    lastSeen: Date.now()
  };
  saveOnlineMap(m);
}
function markOffline(){
  const u=currentUser();
  if(!u) return;
  const m=getOnlineMap();
  const key=String(u.email||"").toLowerCase();
  delete m[key];
  saveOnlineMap(m);
}
function cleanupOnline(staleMs=90000){
  const m=getOnlineMap();
  const now=Date.now();
  let changed=false;
  Object.keys(m).forEach(k=>{
    const it=m[k];
    if(!it || !it.lastSeen || (now - it.lastSeen) > staleMs){
      delete m[k];
      changed=true;
    }
  });
  if(changed) saveOnlineMap(m);
  return m;
}
function renderOnlineUsers(){
  const wrap = $("onlineUsers");
  if(!wrap) return;
  if(!isAdmin()) { wrap.innerHTML = ""; return; }
  const m = cleanupOnline();
  const items = Object.values(m).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  if(!items.length){
    wrap.innerHTML = `<div class="muted small">Sem utilizadores online.</div>`;
    return;
  }
  wrap.innerHTML = items.map(it=>`
    <div class="onlineItem">
      <span class="dot online"></span>
      <div>
        <div><b>${escapeHtml(it.name||it.email)}</b> <span class="muted small">(${escapeHtml(it.role||"")})</span></div>
        <div class="muted small">Ativo: ${fmtDT(new Date(it.lastSeen).toISOString())}</div>
      </div>
    </div>
  `).join("");
}


function applyNavPerms(){
  // Hide/show tabs based on permissions. Admin sees all.
  const isA = hasPerm(PERMS.ADMIN) || (currentUser() && currentUser().role==="Administrador");
  const btnHistUtil = qa('.navbtn').find(b=>b.dataset.tab==="histutil");
  const tabHistUtil = $("tab-histutil");
  const allowHistUtil = isA || hasPerm("histutil_view");
  if(btnHistUtil) btnHistUtil.style.display = allowHistUtil ? "" : "none";
  if(tabHistUtil) tabHistUtil.classList.add("hidden"); // não mostrar na Dashboard (só quando selecionado)

  const btnUsersTab = qa('.navbtn').find(b=>b.dataset.tab==="utilizadores");
  const allowUsersTab = isA; // apenas Administrador
  if(btnUsersTab) btnUsersTab.style.display = allowUsersTab ? "" : "none";

  // Configurações: apenas Administrador ou quem tiver permissão atribuída (cfg_view/cfg_edit)
  const btnCfgTab = qa('.navbtn').find(b=>b.dataset.tab==="config");
  const allowCfgTab = isA || hasPerm("cfg_view") || hasPerm("cfg_edit");
  if(btnCfgTab) btnCfgTab.style.display = allowCfgTab ? "" : "none";
}

/* ---------- UI: tabs ---------- */
function canViewUsers(){
  try{ return isAdmin() || (currentUser() && currentUser().role==="Administrador"); }catch(e){ return false; }
}
function canViewHistUtil(){
  try{
    const u = currentUser();
    const isA = !!(u && u.role==="Administrador");
    return isA || hasPerm("histutil_view");
  }catch(e){ return false; }
}

function canViewConfig(){
  try{
    const u = currentUser();
    const isA = !!(u && u.role==="Administrador");
    return isA || hasPerm("cfg_view") || hasPerm("cfg_edit");
  }catch(e){ return false; }
}
function showTab(tab){
  if(tab==="histutil" && !canViewHistUtil()) { tab="dashboard"; }
  if(tab==="utilizadores" && !canViewUsers()) { tab="dashboard"; }
  if(tab==="config" && !canViewConfig()) { tab="dashboard"; }
  qa(".navbtn").forEach(b=>b.classList.toggle("active", b.dataset.tab===tab));
  qa(".tab").forEach(s=>s.classList.add("hidden"));
  $(`tab-${tab}`).classList.remove("hidden");
  audit("NAV", tab);
  // refresh views
  if(tab==="dashboard"){ setTimeout(()=>map?.invalidateSize(true), 200); renderDashboard(); }
  if(tab==="dataloggers"){ renderDLTable(); }
  if(tab==="caudalimetros"){ renderCTable(); }
  if(tab==="historico"){ renderHistorico();
  wireHistoricoDeleteDelegation(); }
  if(tab==="utilizadores"){ renderUsers(); }
  if(tab==="histutil"){ renderAudit(); }
  if(tab==="config"){ renderConfig(); }

  // Charts in hidden tabs may render with wrong width (0px) and appear "missing".
  // Force a reflow + redraw after the tab becomes visible.
  setTimeout(()=>{ try{ redrawVisibleCharts(); }catch(e){} }, 60);
}

function _isVisible(el){
  return !!(el && el.getBoundingClientRect && el.getBoundingClientRect().width>0 && el.getBoundingClientRect().height>0);
}

function redrawVisibleCharts(){
  // Dashboard chart
  const dc = $("dashChart");
  if(_isVisible(dc) && _dashSel && _dashSel.kind && _dashSel.id){
    try{ renderDashboardDeviceChart(_dashSel.kind, _dashSel.id); }catch(e){}
  }
  // Histórico chart
  const hc = $("histChart");
  if(_isVisible(hc)){
    try{ renderHistorico(); }catch(e){}
  }
  // Device details chart (modal)
  const devc = $("devChart");
  if(_isVisible(devc)){
    try{
      const k = devc.getAttribute("data-kind");
      const id = devc.getAttribute("data-id");
      if(k && id) renderDeviceChart(k, id);
    }catch(e){}
  }
}

/* ---------- Charts: auto refresh + robust rendering ---------- */
let __chartsAutoTimer = null;
let __dashLastKey = "";
let __dashLastT = "";
let __histLastKey = "";
let __histLastT = "";

function _activeTab(){
  try{
    const b = qa('.navbtn').find(x=>x.classList.contains('active'));
    return b ? (b.dataset.tab||'') : '';
  }catch(e){
    return '';
  }
}

function _lastPointTime(kind, id){
  try{
    const h = getHist();
    if(kind==="datalogger"){
      const arr = (h.dl && h.dl[id]) ? h.dl[id] : [];
      return arr.length ? String(arr[arr.length-1].t||"") : "";
    }
    if(kind==="caudal"){
      const arr = (h.c && h.c[id]) ? h.c[id] : [];
      return arr.length ? String(arr[arr.length-1].t||"") : "";
    }
    if(kind==="meteo"){
      const city = id;
      const arr = (h.meteo||[]).filter(x=>!city || String(x.city||"")===String(city));
      return arr.length ? String(arr[arr.length-1].t||"") : "";
    }
    return "";
  }catch(e){
    return "";
  }
}

function _ensureCanvasRenderable(canvas, fn){
  try{
    const parentW = canvas?.parentElement?.clientWidth || 0;
    const rectW = canvas?.getBoundingClientRect?.().width || 0;
    if(parentW < 50 || rectW < 10){
      // tab is hidden or layout not settled yet; retry shortly
      requestAnimationFrame(()=> setTimeout(fn, 30));
      return false;
    }
    return true;
  }catch(e){
    requestAnimationFrame(()=> setTimeout(fn, 30));
    return false;
  }
}

function _chartsAutoTick(){
  const tab = _activeTab();

  // Dashboard device chart
  if(tab==="dashboard" && _dashSel && _dashSel.kind && _dashSel.id){
    const key = `${_dashSel.kind}:${_dashSel.id}`;
    const t = _lastPointTime(_dashSel.kind, _dashSel.id);
    if(key!==__dashLastKey || t!==__dashLastT){
      __dashLastKey = key;
      __dashLastT = t;
      const c = $("dashChart");
      if(c && _ensureCanvasRenderable(c, ()=>renderDashboardDeviceChart(_dashSel.kind, _dashSel.id))){
        try{ renderDashboardDeviceChart(_dashSel.kind, _dashSel.id); }catch(e){}
      }
    }
  }

  // Histórico chart
  if(tab==="historico"){
    const kind = $("histKind")?.value || "datalogger";
    const id = $("histDevice")?.value || "";
    const agg = $("histAgg")?.value || "raw";
    const range = $("histRange")?.value || "";
    const day = $("histDate")?.value || "";
    const key = `${kind}:${id}:${agg}:${range}:${day}`;
    const t = _lastPointTime(kind, id);
    if(key!==__histLastKey || t!==__histLastT){
      __histLastKey = key;
      __histLastT = t;
      const c = $("histChart");
      if(c && _ensureCanvasRenderable(c, ()=>renderHistorico())){
        try{ renderHistorico(); }catch(e){}
      }
    }
  }
}

function startChartsAutoRefresh(){
  if(__chartsAutoTimer) return;
  __chartsAutoTimer = setInterval(()=>{
    try{ _chartsAutoTick(); }catch(e){}
  }, 2500);
}

// Histórico de Dados: refresh explícito (botão) + refresh periódico (10 em 10 minutos)
const HISTORICO_REFRESH_INTERVAL = 10*60*1000;
let __histRefreshTimer = null;
async function forceHistoricoRefresh(){
  // Forçar re-render mesmo que a key/timestamp não tenham mudado.
  try{ __histLastKey = null; __histLastT = null; }catch(e){}

  // Se for meteorologia, atualizar o cache.
  // Se for DL/C, e existir link SCADA, puxar ponto antes de redesenhar.
  try{
    const tab = _activeTab();
    if(tab==="historico"){
      const kind = $("histKind")?.value || "datalogger";
      if(kind==="meteo"){
        await updateMeteoForAllLocalities();
      } else {
        const id = $("histDevice")?.value || "";
        const list = kind==="datalogger" ? getDL() : getC();
        const dev = list.find(d=>String(d.id)===String(id));
        try{ if(sbEnabled() && id) await sbLoadTelemetryIntoHist(id, kind); }catch(e){}
        if(dev && dev.scada_url && String(dev.scada_url).trim()){
          await fetchScadaForDevice(kind, dev);
        }
      }
    }
  }catch(e){}

  try{ renderHistorico(); }catch(e){}
}

function startHistoricoAutoRefresh(){
  if(__histRefreshTimer) return;
  __histRefreshTimer = setInterval(()=>{
    try{
      if(_activeTab()==="historico"){
        forceHistoricoRefresh();
      }
    }catch(e){}
  }, HISTORICO_REFRESH_INTERVAL);
}

// Meteorologia: atualização automática do cache de todas as localidades (para Histórico de Dados)
const METEO_ALL_REFRESH_INTERVAL = 10*60*1000;
let __meteoAllTimer = null;
function startMeteoAllAutoUpdate(){
  if(__meteoAllTimer) return;
  __meteoAllTimer = setInterval(()=>{
    try{ updateMeteoForAllLocalities(); }catch(e){}
    try{ void updateMeteoHist1yForAllLocalities(); }catch(e){}
  }, METEO_ALL_REFRESH_INTERVAL);
}

// SCADA: automatic polling (optional)
const SCADA_REFRESH_INTERVAL = 10*60*1000;
let __scadaTimer = null;
function startScadaAutoUpdate(){
  if(__scadaTimer) return;
  __scadaTimer = setInterval(async ()=>{
    try{
      // Poll only when logged in (dashboard visible)
      if(!currentUser()) return;
      await fetchScadaForAll("datalogger");
      await fetchScadaForAll("caudal");
    }catch(e){}
  }, SCADA_REFRESH_INTERVAL);
}

/* ---------- Modal ---------- */
function openModal(title, bodyHtml){
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = bodyHtml;
  $("modal").classList.remove("hidden");
}
function closeModal(){ $("modal").classList.add("hidden"); }
function confirmBox(title, message, onYes){
  openModal(title, `
    <div class="panel">
      <div class="muted small" style="margin-bottom:10px">${escapeHtml(message)}</div>
      <div class="toolbar" style="justify-content:flex-end">
        <button class="btn" id="btnNo" type="button">Cancelar</button>
        <button class="btn danger" id="btnYes" type="button">Eliminar</button>
      </div>
    </div>
  `);
  $("btnNo").onclick=closeModal;
  $("btnYes").onclick=()=>{ closeModal(); onYes(); };
}

/* ---------- Devices (Data Logger´s / Caudalímetros) ---------- */
function getCfg(){ return load(LS.config, {}); }
function setCfg(cfg){ save(LS.config, cfg); }

function rnd(){ return Math.random(); }
function jitter(lat,lng,km=6){
  const dlat = (rnd()-0.5) * (km/111);
  const dlng = (rnd()-0.5) * (km/(111*Math.cos(lat*Math.PI/180)));
  return [lat+dlat, lng+dlng];
}

function makeDevices(prefix, count){
  const cfg = getCfg();
  const municipios = (cfg.municipios && cfg.municipios.length) ? cfg.municipios : DEFAULT_MUNICIPIOS;
  const rios = (cfg.rios && cfg.rios.length) ? cfg.rios : DEFAULT_RIOS;
  const list=[];
  for(let i=1;i<=count;i++){
    const municipio = municipios[i % municipios.length];
    const center = MUNICIPIO_CENTERS[municipio] || MUNICIPIO_CENTERS["Guimarães"];
    const [lat,lng]=jitter(center[0], center[1], 7);
    const level = clamp(Math.round(10 + rnd()*90), 0, 100);
    const flow = +( (prefix==="DL" ? (5+rnd()*80) : (10+rnd()*220)) ).toFixed(1);
    list.push({
      id: `${prefix}-${i}`,
      name: `${prefix==="DL" ? "DL" : "C"}-${String(i).padStart(3,"0")}`,
      municipio,
      rio: rios[i % rios.length],
      lat:+lat.toFixed(6),
      lng:+lng.toFixed(6),
      level_pct: level,
      flow_lps: flow,   // SCADA instant flow
      status: "ativo",  // ativo/inativo
      imei: `356${String(Math.floor(100000000000+rnd()*899999999999))}`,
      install_date: "",
      purchase_date: "",
      battery_changes: [], // {t,text}
      battery_days_left: Math.floor(30 + rnd()*365),
      mc_type: prefix==="C" ? "Eletromagnéticos" : "",
      freguesia: "",
      localidade: "",
      maintenance: [], // {t,text}
      inspections: []  // {t,text,photos:[{name,dataUrl}]}  (photos stored as dataURL)
    });
  }
  return list;
}
function getDL(){
  const list = load(LS.dl, []);
  if(!list.length){ const seeded = makeDevices('DL', 56); save(LS.dl, seeded); return seeded; }
  let changed=false;
  list.forEach((d,i)=>{
    if(!d.caixa_visita){
      d.caixa_visita = `CV-DL-${String(i+1).padStart(3,"0")}`;
      changed=true;
    }
    if(!d.sim){
      // fictitious Portuguese mobile SIM number starting with 93
      const base = 930000000 + (i*137) % 99999999;
      d.sim = String(base).slice(0,9);
      changed=true;
    }
  });
  if(changed) save(LS.dl, list);
  return list;
}
function setDL(list){ save(LS.dl, list); try{ if(sbEnabled()) list.forEach(d=>sbUpsertDevice({ ...d, type:"datalogger" })); }catch(e){} }
function getC(){
  const list = load(LS.c, []);
  if(!list.length){ const seeded = makeDevices('C', 76); save(LS.c, seeded); return seeded; }
  let changed=false;
  list.forEach((d,i)=>{
    if(!d.caixa_visita){
      d.caixa_visita = `CV-C-${String(i+1).padStart(3,"0")}`;
      changed=true;
    }
  });
  if(changed) save(LS.c, list);
  return list;
}
function setC(list){ save(LS.c, list); try{ if(sbEnabled()) list.forEach(c=>sbUpsertDevice({ ...c, type:"caudalimetro" })); }catch(e){} }

/* ---------- Map ---------- */
let map=null, layerOSM=null, layerSAT=null;
let markersDL = new Map();
let markersC = new Map();

// RainViewer radar overlay (Dashboard map)
let rvDashLayer = null;
let rvDashActive = false;

function statusColor(level){
  const v=Number(level)||0;
  if(v<50) return "g";
  if(v<80) return "y";
  if(v<90) return "o";
  return "r";
}
function iconHTML(kind, level, flow, name, sizePx){
  const cls = kind==="datalogger" ? "dl" : "c";
  const st = statusColor(level);
  const qv = (flow===undefined||flow===null) ? "—" : String(flow);
  const nm = name ? escapeHtml(String(name)) : "";
  const sp = Number(sizePx||0);
  // Pass size to CSS via custom property so text/padding can scale with zoom.
  // NOTE: User requested to remove icons from map markers and keep ALL info visible inside the square.
  const lvlTxt = `${Math.round(Number(level)||0)}%`;
  return `<div class="mkr ${cls} ${st}" style="--mkrPx:${sp}px">
    <div class="mkri">
      ${nm?`<div class="mkrName" title="${nm}">${nm}</div>`:""}
      <div class="lvl">${lvlTxt}</div>
      <div class="q">Q: ${escapeHtml(qv)} m³</div>
    </div>
  </div>`;
}
function markerSizeForZoom(z){
  // Much smaller at low zoom to avoid overlap; grows steadily with zoom.
  // z11≈27px, z13≈41px, z16≈62px, z19≈83px
  const zz = Number(z||11);
  const px = 20 + (zz - 10) * 7;
  return Math.max(24, Math.min(96, Math.round(px)));
}
function makeIcon(kind, level, flow, name, sizePx){
  const s = Number(sizePx||96);
  return L.divIcon({
    className:"",
    html:iconHTML(kind, level, flow, name, s),
    iconSize:[s,s],
    iconAnchor:[Math.round(s/2), Math.round(s/2)]
  });
}

function initMap(){

  // Prevent double-initialization (which can cause flicker and lost handlers).
  if(window.__adnMapInited) return;

  const mapEl = document.getElementById("map");
  if(!mapEl) return;
  // Fallback: if Leaflet is unavailable (e.g., CDN blocked/offline), render an OSM embed so the Dashboard still shows a map.
  if(!window.L){
    // Leaflet may still be loading from a fallback CDN. Retry a few times before giving up.
    window.__leafletRetry = (window.__leafletRetry||0) + 1;
    if(window.__leafletRetry <= 12){
      setTimeout(()=>{ try{ initMap(); }catch(e){} }, 500);
    }
    const lat = 41.4444, lng = -8.2962;
    const left = lng - 0.25, bottom = lat - 0.18, right = lng + 0.25, top = lat + 0.18;
    const bbox = left + "," + bottom + "," + right + "," + top;
    const src = "https://www.openstreetmap.org/export/embed.html?bbox=" +
      encodeURIComponent(bbox) +
      "&layer=mapnik&marker=" + encodeURIComponent(lat + "," + lng);
    // Only render the iframe once to avoid visible blinking while retrying Leaflet loads.
    if(!mapEl.classList.contains("map-iframe-fallback")){
      mapEl.classList.add("map-iframe-fallback");
      mapEl.innerHTML = '<iframe title="Mapa" src="' + src + '" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>';
    }
    return;
  }
  // Ensure the container is empty before Leaflet mounts.
  mapEl.classList.remove("map-iframe-fallback");
  mapEl.innerHTML = "";


let _mkrZoomRAF = 0;
function updateMarkerIconsForZoom(){
  if(!map) return;
  if(_mkrZoomRAF) cancelAnimationFrame(_mkrZoomRAF);
  _mkrZoomRAF = requestAnimationFrame(()=>{
    _mkrZoomRAF = 0;
    const z = map.getZoom ? map.getZoom() : 11;
    const size = markerSizeForZoom(z);
    const upd = (m)=>{
      const meta = m && m._adnMeta;
      if(!meta) return;
      m.setIcon(makeIcon(meta.kind, meta.level, meta.flow, meta.name, size));
    };
    markersDL.forEach(upd);
    markersC.forEach(upd);
  });
}


  if(!window.L) return;
  map = L.map("map", { scrollWheelZoom:true }).setView([41.4444, -8.2962], 11);
  window.__adnMapInited = true;
  map.on("zoomend", updateMarkerIconsForZoom);
  layerOSM = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19, attribution:"© OpenStreetMap" });
  layerSAT = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom:19, attribution:"© Esri" });
  layerOSM.addTo(map);

  const btnLayers = $("btnLayers");
  if(btnLayers) btnLayers.onclick = ()=> $("layersPanel")?.classList.toggle("hidden");
  qa('input[name="basemap"]').forEach(r=>{
    r.addEventListener("change", ()=>{
      const v = q('input[name="basemap"]:checked')?.value || "osm";
      if(v==="osm"){ map.removeLayer(layerSAT); layerOSM.addTo(map); }
      else { map.removeLayer(layerOSM); layerSAT.addTo(map); }
    });
  });
  const btnFitAll = $("btnFitAll");
  if(btnFitAll) btnFitAll.onclick = fitAll;
  const btnMapFull = $("btnMapFull");
  if(btnMapFull) btnMapFull.onclick = toggleMapFullscreen;
  document.addEventListener("fullscreenchange", ()=>{ syncFullscreenBtn(); setTimeout(()=>map?.invalidateSize(true),150); });
  syncFullscreenBtn();
  // Google Earth button removed from UI (keep function available but do not require the element)
  const btnEarth = $("btnOpenEarth");
  if(btnEarth){
    btnEarth.onclick = ()=>{
      const c = map.getCenter();
      openGoogleEarthAt(c.lat, c.lng, map.getZoom());
    };
  }
  const btnExportKML = $("btnExportKML");
  if(btnExportKML) btnExportKML.onclick = downloadKML;

  // Dashboard map search (Data Logger / Caudalímetro by name)
  const msIn = $("mapSearch");
  const msBtn = $("btnMapSearch");
  const doMapSearch = ()=>{
    if(!map) return;
    const term = (msIn?.value || "").trim().toLowerCase();
    if(!term) return;
    const dl = getDL().map(d=>({kind:"datalogger", id:d.id, name:(d.name||"").toString(), lat:d.lat, lng:d.lng}));
    const cc = getC().map(c=>({kind:"caudal", id:c.id, name:(c.name||"").toString(), lat:c.lat, lng:c.lng}));
    const all = dl.concat(cc).filter(x=>x.name);
    const exact = all.find(x=>x.name.toLowerCase()===term);
    const partial = all.find(x=>x.name.toLowerCase().includes(term));
    const hit = exact || partial;
    if(!hit){
      alert("Nenhum equipamento encontrado.");
      return;
    }
    // Ensure layer is visible if user has filtered it off
    if(hit.kind==="datalogger"){
      const f = document.getElementById("fltDL");
      if(f && !f.checked){ f.checked=true; applyMapFilter(); }
    }else{
      const f = document.getElementById("fltC");
      if(f && !f.checked){ f.checked=true; applyMapFilter(); }
    }
    const zMax = (typeof map.getMaxZoom === "function" && map.getMaxZoom()) ? map.getMaxZoom() : 19;
    map.setView([hit.lat, hit.lng], zMax, { animate:true });
    const m = hit.kind==="datalogger" ? markersDL.get(hit.id) : markersC.get(hit.id);
    if(m){ setTimeout(()=>{ try{ m.openPopup(); }catch(e){} }, 250); }
  };
  if(msBtn) msBtn.onclick = doMapSearch;
  if(msIn) msIn.addEventListener("keydown", (e)=>{ if(e.key==="Enter") doMapSearch(); });

  // wire map filter toggles
  const fdl = document.getElementById("fltDL");
  const fc  = document.getElementById("fltC");
  if(fdl) fdl.addEventListener("change", applyMapFilter);
  if(fc)  fc.addEventListener("change", applyMapFilter);
  // wire map filter toggles

  document.addEventListener("click",(e)=>{
    const lp=$("layersPanel"), btn=$("btnLayers");
    if(!lp) return;
    if(lp.classList.contains("hidden")) return;
    if(lp.contains(e.target) || (btn && btn.contains(e.target))) return;
    lp.classList.add("hidden");
  });

  renderMapMarkers();
  // ensure initial sizing uses the current zoom
  updateMarkerIconsForZoom();

  // Force Leaflet to recalculate sizes after flex/layout settles.
  // Without this, the map may render only partially (common in hidden tabs/flex containers).
  try{ setTimeout(()=>{ try{ map && map.invalidateSize(true); }catch(e){} }, 120); }catch(e){}
  try{ setTimeout(()=>{ try{ map && map.invalidateSize(true); }catch(e){} }, 420); }catch(e){}
  if(!window.__adnMapResizeHook){
    window.__adnMapResizeHook = true;
    window.addEventListener("resize", ()=>{ try{ map && map.invalidateSize(true); }catch(e){} });
  }
}

async function ensureDashRadarLayer(){
  if(!map || !window.L) return null;
  try{
    const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", { cache:"no-store" });
    if(!res.ok) throw new Error("RainViewer API: " + res.status);
    const data = await res.json();
    const host = (data.host || "https://tilecache.rainviewer.com").replace(/\/$/,"");
    const frames = []
      .concat((data.radar && data.radar.past) ? data.radar.past : [])
      .concat((data.radar && data.radar.nowcast) ? data.radar.nowcast : []);
    if(!frames.length) throw new Error("Sem frames radar.");
    const last = frames[frames.length-1];
    const path = last.path || ("/v2/radar/" + last.time);
    const tileUrl = host + path + "/256/{z}/{x}/{y}/2/1_1.png";

    if(rvDashLayer){
      try{ map.removeLayer(rvDashLayer); }catch(e){}
      rvDashLayer = null;
    }

    rvDashLayer = L.tileLayer(tileUrl, {
      opacity: 0.7,
      zIndex: 450,
      // RainViewer free tier limits radar tiles to max zoom 10 (as of Jan 2026).
      // Enforce this to avoid blank / partial overlays.
      maxZoom: 10,
      maxNativeZoom: 10,
      updateWhenZooming: false,
      updateWhenIdle: true,
      keepBuffer: 2,
      crossOrigin: true
    });
    return rvDashLayer;
  }catch(e){
    console.warn("Radar indisponível:", e);
    // Fallback: try the stable 'latest' endpoint (works without weather-maps.json)
    try{
      const tileUrl = "https://tilecache.rainviewer.com/v2/radar/latest/256/{z}/{x}/{y}/2/1_1.png";
      if(rvDashLayer){ try{ map.removeLayer(rvDashLayer); }catch(_e){} rvDashLayer=null; }
      rvDashLayer = L.tileLayer(tileUrl, { opacity: 0.7, zIndex:450, maxZoom:10, maxNativeZoom:10, updateWhenZooming:false, updateWhenIdle:true, keepBuffer:2, crossOrigin:true });
      return rvDashLayer;
    }catch(_e){
      return null;
    }
  }
}

async function toggleDashRadar(){
  if(!map) return;
  rvDashActive = !rvDashActive;
  const btn = $("btnMapRadar");
  if(!rvDashActive){
    if(rvDashLayer){ try{ map.removeLayer(rvDashLayer); }catch(e){} }
    if(btn) btn.classList.remove("active");
    return;
  }

  const layer = await ensureDashRadarLayer();
  if(layer){
    layer.addTo(map);
    if(btn) btn.classList.add("active");
    // Mostrar o radar com mais zoom, mas respeitar o limite do overlay (max 10)
    try{ map.setZoom(Math.min(10, Math.max(map.getZoom(), 9))); }catch(e){}
    // Fix partial tiles after toggling
    try{ setTimeout(()=>{ try{ map.invalidateSize(true); }catch(e){} }, 60); }catch(e){}
  }else{
    rvDashActive = false;
    if(btn) btn.classList.remove("active");
    alert("Radar de chuva indisponível neste momento.");
  }
}

function applyMapFilter(){
  if(!map) return;
  const showDL = document.getElementById("fltDL") ? document.getElementById("fltDL").checked : true;
  const showC  = document.getElementById("fltC")  ? document.getElementById("fltC").checked  : true;

  markersDL.forEach(m=>{
    const has = map.hasLayer(m);
    if(showDL && !has) m.addTo(map);
    if(!showDL && has) map.removeLayer(m);
  });
  markersC.forEach(m=>{
    const has = map.hasLayer(m);
    if(showC && !has) m.addTo(map);
    if(!showC && has) map.removeLayer(m);
  });
}

function renderMapMarkers(){
  if(!map) return;
  const size = markerSizeForZoom(map.getZoom ? map.getZoom() : 11);
  // clear old
  markersDL.forEach(m=>map.removeLayer(m));
  markersC.forEach(m=>map.removeLayer(m));
  markersDL.clear(); markersC.clear();

  getDL().forEach(d=>{
    const m=L.marker([d.lat,d.lng], { icon: makeIcon("datalogger", d.level_pct, d.flow_lps, d.name, size) }).addTo(map);
    m.bindPopup(popupHtml("datalogger", d));
    m._adnMeta = { kind:"datalogger", level:d.level_pct, flow:d.flow_lps, name:d.name };
    markersDL.set(d.id, m);
  });
  getC().forEach(c=>{
    const m=L.marker([c.lat,c.lng], { icon: makeIcon("caudal", c.level_pct, c.flow_lps, c.name, size) }).addTo(map);
    m.bindPopup(popupHtml("caudal", c));
    m._adnMeta = { kind:"caudal", level:c.level_pct, flow:c.flow_lps, name:c.name };
    markersC.set(c.id, m);
  });
  applyMapFilter();
}

function popupHtml(kind, d){
  return `
    <b>${escapeHtml(d.name)}</b><br>
    ${escapeHtml(d.municipio)} — ${escapeHtml(d.rio)}<br>
    Nível: <b>${escapeHtml(d.level_pct)}%</b><br>
    Caudal inst.: <b>${escapeHtml(d.flow_lps)} m³</b><br>
    <button class="btn" type="button" onclick="window.openDevice('${kind}','${d.id}')">Abrir</button>
  `;
}

function fitAll(){
  if(!map) return;
  const pts=[];
  getDL().forEach(d=>pts.push([d.lat,d.lng]));
  getC().forEach(c=>pts.push([c.lat,c.lng]));
  if(!pts.length) return;
  map.fitBounds(L.latLngBounds(pts).pad(0.15));
}

function syncFullscreenBtn(){
  const wrap=$("mapWrap");
  const btn=$("btnMapFull");
  if(!wrap||!btn) return;
  const isFs = (document.fullscreenElement===wrap) || wrap.classList.contains("map-fullscreen");
  btn.textContent = isFs ? "Sair ecrã completo" : "Ecrã completo";
}

function toggleMapFullscreen(){
  const wrap=$("mapWrap");
  const btn=$("btnMapFull");
  const isFs = !!document.fullscreenElement || wrap.classList.contains("map-fullscreen");
  const exit=async ()=>{
    try{ if(document.fullscreenElement) await document.exitFullscreen(); }catch{}
    wrap.classList.remove("map-fullscreen");
    syncFullscreenBtn();
    setTimeout(()=>map?.invalidateSize(true), 200);
  };
  const enter=async ()=>{
    try{
      if(wrap.requestFullscreen) await wrap.requestFullscreen();
      else throw new Error("no fs");
    }catch{
      wrap.classList.add("map-fullscreen");
    }
    syncFullscreenBtn();
    setTimeout(()=>map?.invalidateSize(true), 250);
  };
  isFs ? exit() : enter();
}

/* ---------- Google Earth / KML ---------- */
function openGoogleEarthAt(lat,lng,zoom=14){
  const z = clamp(Number(zoom)||14, 1, 20);
  const url = `https://earth.google.com/web/@${lat},${lng},${(2000/(z||1)).toFixed(1)}a,${z}d,35y,0h,0t,0r`;
  window.open(url, "_blank", "noopener");
}
function kmlColor(level){
  const c=statusColor(level);
  if(c==="g") return "ff00ff00";
  if(c==="y") return "ff00ffff";
  if(c==="o") return "ff00a5ff";
  return "ff0000ff";
}
function buildKML(){
  const placemarks=[];
  function pm(name,desc,lat,lng,color,iconHref){
    return `
    <Placemark>
      <name>${escapeHtml(name)}</name>
      <description><![CDATA[${desc}]]></description>
      <Style>
        <IconStyle>
          <color>${color}</color>
          <scale>1.1</scale>
          <Icon><href>${iconHref}</href></Icon>
        </IconStyle>
        <LabelStyle><scale>0.9</scale></LabelStyle>
      </Style>
      <Point><coordinates>${lng},${lat},0</coordinates></Point>
    </Placemark>`;
  }
  const iconDL="http://maps.google.com/mapfiles/kml/paddle/blu-circle.png";
  const iconC ="http://maps.google.com/mapfiles/kml/paddle/red-circle.png";

  getDL().forEach(d=>{
    const desc = `<b>Tipo:</b> Data Logger<br><b>Município:</b> ${escapeHtml(d.municipio)}<br><b>Rio:</b> ${escapeHtml(d.rio)}<br><b>Nível:</b> ${escapeHtml(d.level_pct)}%<br><b>Q:</b> ${escapeHtml(d.flow_lps)} m³<br><b>Serial No. (SN):</b> ${escapeHtml(d.imei||"")}`;
    placemarks.push(pm(d.name, desc, d.lat, d.lng, kmlColor(d.level_pct), iconDL));
  });
  getC().forEach(c=>{
    const desc = `<b>Tipo:</b> Caudalímetro<br><b>Município:</b> ${escapeHtml(c.municipio)}<br><b>Rio:</b> ${escapeHtml(c.rio)}<br><b>Nível:</b> ${escapeHtml(c.level_pct)}%<br><b>Q:</b> ${escapeHtml(c.flow_lps)} m³<br><b>Serial No. (SN):</b> ${escapeHtml(c.imei||"")}<br><b>Tipo MC:</b> ${escapeHtml(c.mc_type||"")}`;
    placemarks.push(pm(c.name, desc, c.lat, c.lng, kmlColor(c.level_pct), iconC));
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
  <kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
      <name>ADNGest — Equipamentos</name>
      ${placemarks.join("\n")}
    </Document>
  </kml>`;
}
function downloadKML(){
  const kml=buildKML();
  const blob=new Blob([kml], {type:"application/vnd.google-earth.kml+xml"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="ADNGest-equipamentos.kml";
  a.click();
  URL.revokeObjectURL(a.href);
  audit("EXPORT_KML","ADNGest-equipamentos.kml");
}

/* ---------- History / SCADA hooks ---------- */
function getHist(){ return load(LS.hist, {dl:{}, c:{}, meteo:[]}); }
function setHist(h){ save(LS.hist, h); }

function writeDevicePoint(kind, id, point){
  const h=getHist();
  const key = kind==="datalogger" ? "dl" : "c";
  if(!h[key][id]) h[key][id]=[];
  h[key][id].push(point);
  // keep large but bounded
  if(h[key][id].length>200000) h[key][id] = h[key][id].slice(-200000);
  setHist(h);

  // Persist to Supabase (best-effort)
  try{
    if(sbEnabled()){
      void sbInsertTelemetryPoint(kind, id, point).catch(()=>{});
    }
  }catch(e){}
}

/* External integration point (future SCADA):
   payload: { device_id, timestamp?, level_pct?, flow_lps?, ... }
*/
window.applyScadaUpdate = function(kind, payload){
  try{
    const id = payload.device_id;
    const t  = payload.timestamp || nowISO();
    const level = (payload.level_pct!==undefined) ? clamp(Math.round(Number(payload.level_pct)),0,100) : null;
    const flow  = (payload.flow_lps!==undefined) ? +(Math.max(0, Number(payload.flow_lps))).toFixed(1) : null;

    const list = kind==="datalogger" ? getDL() : getC();
    const idx = list.findIndex(x=>x.id===id);
    if(idx<0) return;
    const d = list[idx];
    if(level!==null) d.level_pct=level;
    if(flow!==null) d.flow_lps=flow;
    list[idx]=d;
    if(kind==="datalogger") setDL(list); else setC(list);

    writeDevicePoint(kind, id, { t, level_pct: d.level_pct, flow_lps: d.flow_lps });

    // update marker
    const m = kind==="datalogger" ? markersDL.get(id) : markersC.get(id);
    if(m) m.setIcon(makeIcon(kind==="datalogger"?"datalogger":"caudal", d.level_pct, d.flow_lps, d.name));
    renderDashboard();
    // alerts
    maybeTriggerAlert(kind, d);
  }catch(e){
    console.error(e);
  }
};

/* Simulated data generation (meteo-driven) */
function tickSimulateHistory(){
  // Keep legacy entrypoint but drive the evolution by precipitation (hourly).
  try{ meteoDrivenTick(); }catch(e){}
}
let simTimer=null;

/* ---------- Alerts (stub for external server) ---------- */
const __alertCooldown = new Map();
function alertCooldownKey(kind, id, type){
  return `${kind}:${id}:${type}`;
}
async function sendAlertExternal(payload, alertsCfg){
  try{
    const url = String(alertsCfg.external_url||"").trim();
    if(!alertsCfg.external_on || !url) return;
    const method = String(alertsCfg.external_method||"POST").toUpperCase();
    const headers = { "Content-Type": "application/json" };
    if(alertsCfg.external_token){
      headers["Authorization"] = alertsCfg.external_token;
    }
    if(method === "GET"){
      // send compact payload via querystring (best effort)
      const u = new URL(url);
      u.searchParams.set("payload", JSON.stringify(payload));
      await fetch(u.toString(), { method:"GET", headers, cache:"no-store" });
    }else{
      await fetch(url, { method:"POST", headers, body: JSON.stringify(payload), cache:"no-store" });
    }
    audit("ALERT_SENT", `${payload.alert}:${payload.device_id||""}`);
  }catch(e){
    console.warn("alert external failed", e);
    audit("ALERT_SEND_FAIL", String(e && e.message ? e.message : e));
  }
}

function maybeTriggerAlert(kind, dev){
  const cfg=getCfg();
  const a = cfg.alerts || {};
  const t = nowISO();

  const levelLim = Number(a.level ?? 90);
  const flowLim  = Number(a.flow ?? 90);
  const levelNow = Number(dev.level_pct);
  const flowNow  = Number(dev.flow_lps);

  const triggers = [];
  if(a.level_on && Number.isFinite(levelNow) && levelNow >= levelLim) triggers.push("LEVEL_GE_LIMIT");
  if(a.flow_on  && Number.isFinite(flowNow)  && flowNow  >= flowLim)  triggers.push("FLOW_GE_LIMIT");
  if(!triggers.length) return;

  // Anti-spam: 10 min cooldown per device+trigger type
  const nowMs = Date.now();
  const COOLDOWN_MS = 10*60*1000;
  const fire = [];
  for(const type of triggers){
    const k = alertCooldownKey(kind, dev.id, type);
    const last = __alertCooldown.get(k) || 0;
    if(nowMs - last >= COOLDOWN_MS){
      __alertCooldown.set(k, nowMs);
      fire.push(type);
    }
  }
  if(!fire.length) return;

  for(const type of fire){
    const payload = {
      alert: type,
      timestamp: t,
      device_kind: kind,
      device_id: dev.id,
      device: dev.name || "",
      level_pct: Number.isFinite(levelNow) ? levelNow : null,
      flow_m3: Number.isFinite(flowNow) ? flowNow : null,
      notify: {
        email: a.email ? (a.email_to||"") : "",
        phone: a.sms ? (a.sms_to||"") : ""
      }
    };
    audit("ALERT", `${kind}:${dev.id} ${type} nível ${levelNow}% caudal ${flowNow}`);
    // server external (best effort)
    void sendAlertExternal(payload, a);
  }
}

/* ---------- Weather (Open-Meteo) ---------- */
function populateCities(){
  const dl=$("ptCities");
  // Datalist serve apenas como sugestão; o utilizador pode escrever qualquer localidade em Portugal.
  dl.innerHTML = PT_CITY_SUGGESTIONS.map(c=>`<option value="${escapeHtml(c)}"></option>`).join("");
}

// Aplicar localidade na meteorologia (qualquer localidade em PT).
// - Faz geocoding (Open-Meteo) com filtro PT
// - Grava em config (localStorage)
// - Atualiza UI e cache meteorológica
async function applyWeatherLocationFromInput(){
  const inp = $("weatherCity");
  const btn = $("btnWeatherSet");
  if(!inp) return;
  const raw = String(inp.value||"").trim();
  if(!raw){
    try{ $("weatherMeta").textContent = "Indique uma localidade em Portugal."; }catch(e){}
    return;
  }
  const run = async ()=>{
    try{ $("weatherMeta").textContent = "A procurar localidade…"; }catch(e){}
    const geo = await geocodeCityPT(raw);
    const cfg = getCfg();
    cfg.weatherLocation = { name: geo.name, lat: geo.lat, lng: geo.lng };
    save(LS.config, cfg);

    // Também garantir cache meteo para esta localidade (horária) e histórico diário (fallback)
    try{ await ensureMeteoForLoc(geo.name, geo.lat, geo.lng); }catch(e){}
    try{ ensureHistoricoData(); }catch(e){}
    await loadWeather();
    // Se o utilizador estiver no Histórico->Meteorologia, refrescar opções
    try{ if($("histKind") && $("histKind").value==="meteo") renderHistorico(); }catch(e){}
  };
  if(btn){
    await withBtnBusy(btn, run);
  }else{
    await run();
  }
}

// Apply (and persist) a new PT locality for the meteorology widget.
// - Accepts free-text
// - Geocodes using Open-Meteo Geocoding (filtered to PT)
// - Saves in config + refreshes weather and caches
async function applyWeatherLocationFromInput(){
  const input = $("weatherCity");
  const btn = $("btnWeatherSet");
  if(!input) return;
  const name = (input.value||"").trim();
  if(!name){
    try{ $("weatherMeta").textContent = "Indique uma localidade em Portugal."; }catch(e){}
    return;
  }
  const run = async ()=>{
    try{
      const loc = await geocodeCityPT(name);
      const cfg = getCfg();
      cfg.weatherLocation = { name: loc.name, lat: loc.lat, lng: loc.lng };
      save(LS.config, cfg);
      // refresh UI + caches
      await loadWeather();
      try{ await ensureMeteoForLoc(loc.name, loc.lat, loc.lng); }catch(e){}
      try{ renderHistorico(); }catch(e){}
      try{ renderDashboard(); }catch(e){}
    }catch(err){
      console.warn("applyWeatherLocationFromInput failed", err);
      try{ $("weatherMeta").textContent = "Não foi possível encontrar essa localidade em Portugal."; }catch(e){}
    }
  };

  // basic UI busy state
  if(btn){
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "A aplicar…";
    try{ await run(); }finally{ btn.disabled=false; btn.textContent = prev; }
  }else{
    await run();
  }
}
async function geocodeCityPT(name){
  const qname=(name||"").trim();
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", qname);
  url.searchParams.set("count", "5");
  url.searchParams.set("language", "pt");
  url.searchParams.set("format", "json");
  const res=await fetch(url.toString(), {cache:"no-store"});
  if(!res.ok) throw new Error("HTTP "+res.status);
  const data=await res.json();
  const results=(data.results||[]).filter(r=>String(r.country_code||"").toUpperCase()==="PT");
  const r = results[0] || (data.results||[])[0];
  if(!r) throw new Error("notfound");
  return { name: r.name || qname, lat: Number(r.latitude), lng: Number(r.longitude) };
}
async function loadWeather(){
  const cfg=getCfg();
  const loc=cfg.weatherLocation;
  $("weatherCity").value = loc.name || "Guimarães";
  $("weatherHeaderCity").textContent = loc.name || "Guimarães";

  // 7-day daily
  const url=new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(loc.lat));
  url.searchParams.set("longitude", String(loc.lng));
  url.searchParams.set("timezone", "Europe/Lisbon");
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum");
  url.searchParams.set("hourly", "precipitation,temperature_2m");
  url.searchParams.set("forecast_days","7");

  const res=await fetch(url.toString(), {cache:"no-store"});
  if(!res.ok) throw new Error("HTTP "+res.status);
  const data=await res.json();

  const d=data.daily;
  const wrap=$("weather7");
  wrap.innerHTML = d.time.map((t,i)=>{
    const dt=new Date(t);
    const dow=dt.toLocaleDateString("pt-PT",{weekday:"short"});
    const dd=dt.toLocaleDateString("pt-PT",{day:"2-digit",month:"2-digit"});
    const tmax=Math.round(d.temperature_2m_max[i]);
    const tmin=Math.round(d.temperature_2m_min[i]);
    const p=(d.precipitation_sum[i] ?? 0).toFixed(1);
    return `<div class="day"><div class="d">${dow} ${dd}</div><div class="m">Máx ${tmax}° • Mín ${tmin}°</div><div class="m">Precip ${p} mm</div></div>`;
  }).join("");

  $("weatherMeta").textContent = `${loc.name} — atualizado ${new Date().toLocaleString("pt-PT")}`;

  // header now temp/precip (current hour approximation)
  const hourly=data.hourly;
  const now=new Date();
  const idx = hourly.time.findIndex(ts=>{
    const dt=new Date(ts);
    return Math.abs(dt-now) < 60*60*1000;
  });
  if(idx>=0){
    $("weatherHeaderT").textContent = `${Math.round(hourly.temperature_2m[idx])}°C`;
    $("weatherHeaderP").textContent = `P ${Number(hourly.precipitation[idx]||0).toFixed(1)} mm/h`;
  }else{
    $("weatherHeaderT").textContent="—";
    $("weatherHeaderP").textContent="—";
  }

  // precip stats
  const last24 = hourly.precipitation.slice(Math.max(0, hourly.precipitation.length-24)).reduce((a,b)=>a+(Number(b)||0),0);
  $("p24").textContent = `${last24.toFixed(1)} mm`;
  $("ptoday").textContent = `${Number(d.precipitation_sum[0]||0).toFixed(1)} mm`;
  const weekSum = d.precipitation_sum.reduce((a,b)=>a+(Number(b)||0),0);
  $("p7").textContent = `${weekSum.toFixed(1)} mm`;

  // store meteo history snapshot (hourly for last hour)
  const h=getHist();
  const rec = { t: nowISO(), city: loc.name, t_c: idx>=0?hourly.temperature_2m[idx]:null, p_mm_h: idx>=0?hourly.precipitation[idx]:null, lat: loc.lat, lng: loc.lng, name: loc.name };
  h.meteo.push(rec);
  if(h.meteo.length>200000) h.meteo=h.meteo.slice(-200000);
  setHist(h);

  // Persist meteo to Supabase (best-effort)
  try{ if(sbEnabled()) void sbInsertMeteoPoint(loc.name, rec).catch(()=>{}); }catch(e){}
}

// v45 - Fetch real precipitation for all localities present in the app (cached)
// Uses Open-Meteo Geocoding + Forecast API (no key). Cache refresh every 6 hours.
function getAllLocalities(){
  const dls=getDL(); const cs=getC();
  const set=new Set();
  [...dls, ...cs].forEach(d=>{
    const muni=(d.municipio||"").trim();
    const loc=(d.localidade||"").trim();
    if(muni) set.add(muni);
    if(loc) set.add(loc);
  });
  return [...set].filter(Boolean);
}
function getMeteoCache(){
  return load(LS.meteoCache, {});
}
function saveMeteoCache(cache){
  save(LS.meteoCache, cache);
}
async function fetchHourlyPrecipForPlacePT(place){
  // geocode
  const g = await geocodeCityPT(place);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(g.lat));
  url.searchParams.set("longitude", String(g.lng));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("hourly", "precipitation");
  url.searchParams.set("past_days","7");
  url.searchParams.set("forecast_days","2");
  const res = await fetch(url.toString(), {cache:"no-store"});
  if(!res.ok) throw new Error("HTTP "+res.status);
  const data = await res.json();
  const h = data.hourly || {};
  return { name: g.name||place, lat:g.lat, lng:g.lng, updatedAt: Date.now(), hourly:{ time:h.time||[], precipitation:h.precipitation||[] } };
}


async function fetchDailyPrecip1YearForPlacePT(place){
  const g = await geocodeCityPT(place);
  const end = new Date();
  const start = new Date(end.getTime() - 365*24*60*60*1000); // ~1 year
  const fmt = (dt)=>dt.toISOString().slice(0,10);
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.searchParams.set("latitude", String(g.lat));
  url.searchParams.set("longitude", String(g.lng));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("start_date", fmt(start));
  url.searchParams.set("end_date", fmt(end));
  url.searchParams.set("daily", "precipitation_sum");
  const res = await fetch(url.toString(), {cache:"no-store"});
  if(!res.ok) throw new Error("HTTP "+res.status);
  const data = await res.json();
  const d = data.daily || {};
  const times = d.time || [];
  const prec  = d.precipitation_sum || [];
  const arr = [];
  for(let i=0;i<times.length;i++){
    const t = Date.parse(times[i]+"T12:00:00Z");
    const mm = Number(prec[i] ?? 0) || 0;
    arr.push({ t, rain_mm: +mm.toFixed(2) });
  }
  return { name: g.name||place, lat:g.lat, lng:g.lng, updatedAt: Date.now(), daily: arr };
}

async function updateMeteoHist1yForAllLocalities(){
  const places = getAllLocalities();
  if(!places.length) return;
  const key = "adngest_meteo_hist_v1";
  let store = {};
  try{ store = JSON.parse(localStorage.getItem(key) || "{}"); }catch(e){ store = {}; }
  store.locs = store.locs || {};
  store.updatedAt = store.updatedAt || {};
  const now = Date.now();
  for(const p of places){
    const last = store.updatedAt[p] || 0;
    const stale = (now - last) > 24*60*60*1000; // refresh daily
    if(!stale && Array.isArray(store.locs[p]) && store.locs[p].length>50) continue;
    try{
      const res = await fetchDailyPrecip1YearForPlacePT(p);
      store.locs[p] = (res.daily||[]).map(x=>({ t:x.t, rain_mm:x.rain_mm }));
      store.updatedAt[p] = now;
      localStorage.setItem(key, JSON.stringify(store));
    }catch(e){
      // keep whatever exists
    }
  }
}


async function updateMeteoForAllLocalities(){
  const places = getAllLocalities();
  if(!places.length) return;
  const cache = getMeteoCache();
  const now = Date.now();
  // sequential to be gentle on API
  for(const p of places){
    const key = p;
    const cur = cache[key];
    const stale = !cur || !cur.updatedAt || (now - cur.updatedAt) > 6*60*60*1000;
    if(!stale) continue;
    try{
      cache[key] = await fetchHourlyPrecipForPlacePT(p);
      saveMeteoCache(cache);
    }catch(e){
      // keep last good cache
    }
  }

  // Record a history snapshot for every locality we have cached.
  // This allows the "Histórico de Dados -> Meteorologia" to show all localities.
  try{
    const h=getHist();
    const nowDt = new Date();
    const nowIso = nowISO();
    for(const p of places){
      const it = cache[p];
      if(!it || !it.hourly || !Array.isArray(it.hourly.time) || !Array.isArray(it.hourly.precipitation)) continue;
      const times = it.hourly.time;
      const prec = it.hourly.precipitation;
      if(!times.length || !prec.length) continue;
      // find closest hour
      let best=-1, bestDiff=1e18;
      for(let i=0;i<times.length;i++){
        const dt=new Date(times[i]);
        const diff=Math.abs(dt-nowDt);
        if(diff<bestDiff){ bestDiff=diff; best=i; }
      }
      const city = it.name || p;
      const pmm = best>=0 ? (prec[best] ?? null) : null;
      // de-duplicate: if last record for this city is within 30 minutes, don't add another.
      const last = [...h.meteo].reverse().find(x=>String(x.city||"")===String(city));
      if(last){
        const dtLast = new Date(last.t);
        if(Math.abs(dtLast - nowDt) < 30*60*1000) continue;
      }
      const rec = { t: nowIso, city, t_c: null, p_mm_h: pmm, lat: it.lat ?? null, lng: it.lng ?? null, name: it.name || p };
      h.meteo.push(rec);
      try{ if(sbEnabled()) void sbInsertMeteoPoint(city, rec).catch(()=>{}); }catch(e){}
    }
    if(h.meteo.length>200000) h.meteo=h.meteo.slice(-200000);
    setHist(h);
  }catch(e){
    // ignore
  }
}
function renderMeteoSource(){
  const el = $("weatherSource");
  if(!el) return;
  el.innerHTML = 'Fonte: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open‑Meteo</a> (Forecast API) + <a href="https://open-meteo.com/en/docs/geocoding-api" target="_blank" rel="noopener">Geocoding API</a>.';
}

/* ---------- Dashboard render ---------- */
function avgFlow(list){
  return list.length ? (list.reduce((a,b)=>a+(Number(b.flow_lps)||0),0)/list.length) : 0;
}
function renderDashboard(){
  const dls=getDL(), cs=getC();
  $("kpiDL").textContent=String(dls.length);
  $("kpiC").textContent=String(cs.length);
  $("kpiDLFlow").textContent=`Caudal inst. (médio): ${avgFlow(dls).toFixed(1)} m³`;
  $("kpiCFlow").textContent=`Caudal inst. (médio): ${avgFlow(cs).toFixed(1)} m³`;
  $("dlInstantFlow").textContent=`Caudal inst. (médio): ${avgFlow(dls).toFixed(1)} m³`;
  $("cInstantFlow").textContent=`Caudal inst. (médio): ${avgFlow(cs).toFixed(1)} m³`;
  renderQuickLists();
}

function renderQuickLists(){
  const qdl=($("qDL").value||"").trim().toLowerCase();
  const qc=($("qC").value||"").trim().toLowerCase();
  const dls=getDL().filter(d=>{
    const hay=(d.name+" "+d.municipio+" "+d.rio).toLowerCase();
    return !qdl || hay.includes(qdl);
  }).slice(0, 18);
  const cs=getC().filter(c=>{
    const hay=(c.name+" "+c.municipio+" "+c.rio).toLowerCase();
    return !qc || hay.includes(qc);
  }).slice(0, 18);

  $("quickDL").innerHTML = dls.map(d=>`
    <div class="quickitem" data-dashpick-kind="datalogger" data-dashpick-id="${d.id}" data-dashpick-name="${escapeHtml(d.name)}"><div><b>${escapeHtml(d.name)}</b> • <span class="muted small">${escapeHtml(d.municipio)} — ${escapeHtml(d.rio)}</span></div>
      <div class="muted small">Nível <b>${escapeHtml(d.level_pct)}%</b> • Q <b>${escapeHtml(d.flow_lps)} m³</b></div>
    </div>
  `).join("") || `<div class="muted small">Sem resultados.</div>`;

  $("quickC").innerHTML = cs.map(c=>`
    <div class="quickitem" onclick="window.selectDashboardDeviceById('caudal','${c.id}')">
      <div><b>${escapeHtml(c.name)}</b> • <span class="muted small">${escapeHtml(c.municipio)} — ${escapeHtml(c.rio)}</span></div>
      <div class="muted small">Nível <b>${escapeHtml(c.level_pct)}%</b> • Q <b>${escapeHtml(c.flow_lps)} m³</b></div>
    </div>
  `).join("") || `<div class="muted small">Sem resultados.</div>`;
}

/* ---------- Device modal (details + maintenance + inspections) ---------- */
window.__pendingDevices = window.__pendingDevices || {};

window.openDevice = function(kind, id, opts={}){
  const list = kind==="datalogger" ? getDL() : getC();
  let d = list.find(x=>x.id===id);
  const pendingKey = `${kind}:${id}`;
  const isNew = !d && window.__pendingDevices && window.__pendingDevices[pendingKey];
  if(!d && isNew) d = window.__pendingDevices[pendingKey];
  if(!d) return;

  // registar abertura do equipamento (histórico de utilizadores)
  try{ audit("DEVICE_OPEN", `${kind}:${id}`, { name: d.name||"" }); }catch(e){}

  const admin = isAdmin();
  const canEdit = canEditKind(kind);

  const minMaxFields = (kind==="datalogger" || kind==="caudal") ? `
        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Nível mín. (%)</div>
            <input class="input" id="detLevelMin" type="number" min="0" max="100" step="0.1" value="${escapeHtml(d.level_min_pct??"")}" ${canEdit?"":"disabled"} />
          </div>
          <div style="flex:1">
            <div class="muted small">Nível máx. (%)</div>
            <input class="input" id="detLevelMax" type="number" min="0" max="100" step="0.1" value="${escapeHtml(d.level_max_pct??"")}" ${canEdit?"":"disabled"} />
          </div>
        </div>
        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Caudal mín. (m³)</div>
            <input class="input" id="detFlowMin" type="number" step="0.1" value="${escapeHtml(d.flow_min_m3??"")}" ${canEdit?"":"disabled"} />
          </div>
          <div style="flex:1">
            <div class="muted small">Caudal máx. (m³)</div>
            <input class="input" id="detFlowMax" type="number" step="0.1" value="${escapeHtml(d.flow_max_m3??"")}" ${canEdit?"":"disabled"} />
          </div>
        </div>
        ` : ``;

  const statusSel = `
    <select class="input" id="detStatus" ${canEdit?"":"disabled"}>
      <option value="ativo" ${d.status==="ativo"?"selected":""}>Ativo</option>
      <option value="inativo" ${d.status==="inativo"?"selected":""}>Inativo</option>
    </select>`;

  const mcSel = kind==="caudal" ? `
    <select class="input" id="detMC" ${canEdit?"":"disabled"}>
      <option value="Eletromagnéticos" ${d.mc_type==="Eletromagnética"?"selected":""}>Eletromagnéticos</option>
      <option value="Sonda VRADI" ${d.mc_type==="Sonda VRADI"?"selected":""}>Sonda VRADI</option>
    </select>` : "";

  const simField = kind==="datalogger" ? `
          <div style="flex:1">
            <div class="muted small">SIM</div>
            <input class="input" id="detSIM" value="${escapeHtml(d.sim||"")}" ${canEdit?"":"disabled"} />
          </div>` : "";

  openModal(`${isNew?"Novo":"Detalhes"} — ${escapeHtml(d.name)}`, `
    <div class="grid2" style="grid-template-columns:1fr 1fr">
      <div class="panel">
        <div class="panel-title">Dados</div>
        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Nome</div>
            <input class="input" id="detName" value="${escapeHtml(d.name)}" ${canEdit?"":"disabled"} />
          </div>
          <div style="flex:1">
            <div class="muted small">${kind==="caudal"?"Serial No. (SN)":"IMEI"}</div>
            <input class="input" id="detIMEI" value="${escapeHtml(d.imei||"")}" ${canEdit?"":"disabled"} />
          </div>
          ${simField}
        </div>

        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Município</div>
            <input class="input" id="detMunicipio" value="${escapeHtml(d.municipio)}" ${canEdit?"":"disabled"} />
          </div>
          <div style="flex:1">
            <div class="muted small">Rio/Interceptor</div>
            <input class="input" id="detRio" value="${escapeHtml(d.rio)}" ${canEdit?"":"disabled"} />
          </div>
        </div>

        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Caixas de visita</div>
            <input class="input" id="detCV" value="${escapeHtml(d.caixa_visita||"")}" ${canEdit?"":"disabled"} />
          </div>
          <div style="flex:1">
            <div class="muted small">${kind==="caudal"?"Tipo MC":" "}</div>
            ${mcSel || `<div class="input" style="opacity:.0">—</div>`}
          </div>
        </div>

        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Freguesia</div>
            <input class="input" id="detFreg" value="${escapeHtml(d.freguesia||"")}" ${canEdit?"":"disabled"} />
          </div>
          <div style="flex:1">
            <div class="muted small">Localidade</div>
            <input class="input" id="detLoc" value="${escapeHtml(d.localidade||"")}" ${canEdit?"":"disabled"} />
          </div>
        </div>

        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Lat</div>
            <input class="input" id="detLat" type="number" step="0.000001" value="${escapeHtml(d.lat)}" ${canEdit?"":"disabled"} />
          </div>
          <div style="flex:1">
            <div class="muted small">Lng</div>
            <input class="input" id="detLng" type="number" step="0.000001" value="${escapeHtml(d.lng)}" ${canEdit?"":"disabled"} />
          </div>
        </div>

        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Nível (%)</div>
            <input class="input" id="detLevel" type="number" min="0" max="100" value="${escapeHtml(d.level_pct)}" ${canEdit?"":"disabled"} />
          </div>
          <div style="flex:1">
            <div class="muted small">Caudal inst. (m³)</div>
            <input class="input" id="detFlow" type="number" step="0.1" value="${escapeHtml(d.flow_lps)}" ${canEdit?"":"disabled"} />
          </div>
        </div>

        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Link SCADA (JSON)</div>
            <input class="input" id="detScadaUrl" value="${escapeHtml(d.scada_url||"")}" ${isAdmin()?"":"disabled"} placeholder="https://.../scada/${escapeHtml(d.id)}.json" />
          </div>
          <div style="width:160px; display:flex; align-items:flex-end; justify-content:flex-end">
            <button class="btn" id="btnScadaNow" type="button" ${(!isAdmin()||!(d.scada_url&&String(d.scada_url).trim()))?"disabled":""}>Atualizar SCADA</button>
          </div>
        </div>

        ${minMaxFields}

        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Estado</div>
            ${statusSel}
          </div>
          ${kind==="caudal" ? `<div style="flex:1"><div class="muted small">Tipo MC</div>${mcSel}</div>` : `<div style="flex:1"><div class="muted small">—</div><div class="muted small"> </div></div>`}
        </div>

        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Data instalação</div>
            <input class="input" id="detInstall" type="date" value="${escapeHtml(d.install_date||"")}" ${canEdit?"":"disabled"} />
          </div>
          <div style="flex:1">
            <div class="muted small">Data compra</div>
            <input class="input" id="detPurchase" type="date" value="${escapeHtml(d.purchase_date||"")}" ${canEdit?"":"disabled"} />
          </div>
        </div>

        ${kind==="datalogger" ? `
        <div class="toolbar">
          <div style="flex:1">
            <div class="muted small">Bateria — dias de vida restantes</div>
            <input class="input" id="detBatDays" type="number" min="0" step="1" value="${escapeHtml(d.battery_days_left ?? "")}" ${canEdit?"":"disabled"} />
          </div>
          <div style="flex:1">
            <div class="muted small">—</div>
            <div class="muted small"> </div>
          </div>
        </div>
        ` : ""}

        ${kind==="datalogger" ? `
          <div class="panel" style="margin-top:10px">
            <div class="panel-title">Trocas de bateria</div>
            ${admin ? `<div class="toolbar"><input class="input" id="batText" placeholder="Descrição..." /><button class="btn" id="btnBatAdd" type="button">Adicionar</button></div>` : `<div class="muted small">Apenas admin pode editar.</div>`}
            <div id="batList">${renderLogList(d.battery_changes || [], admin, "bat")}</div>
          </div>
        ` : ""}

      </div>

      <div class="panel">
        <div class="panel-title">Manutenção & Inspeções</div>

        <div class="panel" style="margin-top:10px">
          <div class="panel-title">Manutenção</div>
          ${admin ? `<div class="toolbar"><input class="input" id="mntText" placeholder="O que foi feito..." /><button class="btn" id="btnMntAdd" type="button">Adicionar</button></div>` : `<div class="muted small">Apenas admin pode editar.</div>`}
          <div id="mntList">${renderLogList(d.maintenance || [], admin, "mnt")}</div>
        </div>

        <div class="panel" style="margin-top:10px">
          <div class="panel-title">Inspeções (com fotos)</div>
          ${admin ? `
            <div class="toolbar">
              <input class="input" id="inspText" placeholder="O que foi feito..." />
              <input class="input" id="inspPhotos" type="file" accept="image/*" multiple />
              <button class="btn" id="btnInspAdd" type="button">Adicionar</button>
            </div>` : `<div class="muted small">Apenas admin pode editar.</div>`}
          <div id="inspList">${renderInspections(d.inspections || [], admin)}</div>
        </div>

        <div class="toolbar" style="margin-top:12px; justify-content:flex-end">
          <button class="btn" type="button" onclick="window.focusOn('${kind}','${id}')">Ver no mapa</button>
          ${canEdit ? `<button class="btn" id="btnSaveDet" type="button">Guardar</button>` : ""}
          ${isAdmin() ? `<button class="btn danger" id="btnDeleteDev" type="button">Eliminar</button>` : ""}
        </div>

        <div class="muted small">SCADA: os campos “Nível” e “Caudal inst.” podem ser atualizados automaticamente via <code>applyScadaUpdate()</code>.</div>
      </div>
    </div>
  `);
  try{ renderDeviceChart(kind, id); }catch(e){}
  try{ renderDeviceMini(kind, id); }catch(e){}

  // Wire actions
  window.focusOn = (k, did)=>{
    closeModal();
    showTab("dashboard");
    setTimeout(()=>{
      const m = k==="datalogger" ? markersDL.get(did) : markersC.get(did);
      if(m){ map.setView(m.getLatLng(), 15); m.openPopup(); }
    }, 220);
  };

  if(admin && kind==="datalogger"){
    $("btnBatAdd").onclick = ()=>{
      const txt=($("batText").value||"").trim();
      if(!txt) return;
      d.battery_changes.unshift({ t: nowISO(), text: txt });

      // guardar (apenas) registo de mudança de bateria
      saveDevice(kind, d);
      audit("BATTERY", `${kind}:${d.id}`);
      $("batText").value="";
      $("batList").innerHTML = renderLogList(d.battery_changes, true, "bat");
      wireLogDelete(kind, d, "bat", "batList");
    };
  }
  if(admin){
    $("btnMntAdd")?.addEventListener("click", ()=>{
      const txt=($("mntText").value||"").trim();
      if(!txt) return;
      d.maintenance.unshift({ t: nowISO(), text: txt });
      saveDevice(kind, d);
      audit("MAINTENANCE", `${kind}:${d.id}`);
      $("mntText").value="";
      $("mntList").innerHTML = renderLogList(d.maintenance, true, "mnt");
      wireLogDelete(kind, d, "mnt", "mntList");
    });

    $("btnInspAdd")?.addEventListener("click", async ()=>{
      const txt=($("inspText").value||"").trim();
      const files = Array.from($("inspPhotos").files||[]);
      const photos=[];
      for(const f of files){
        const dataUrl = await fileToDataURL(f);
        photos.push({ name: f.name, dataUrl });
      }
      if(!txt && photos.length===0) return;
      d.inspections.unshift({ t: nowISO(), text: txt, photos });
      saveDevice(kind, d);
      audit("INSPECTION", `${kind}:${d.id}`);
      $("inspText").value="";
      $("inspPhotos").value="";
      $("inspList").innerHTML = renderInspections(d.inspections, true);
      wireInspectionDelete(kind, d);
    });

    // wire delete buttons inside lists
    wireLogDelete(kind, d, "mnt", "mntList");
    wireLogDelete(kind, d, "bat", "batList");
    wireInspectionDelete(kind, d);
  }

  $("btnSaveDet")?.addEventListener("click", ()=>{
    // update d from inputs
    d.name = ($("detName").value||d.name).trim() || d.name;
    d.imei = ($("detIMEI").value||"").trim();
    if(kind==="datalogger") d.sim = ($("detSIM").value||"").trim();
    d.municipio = ($("detMunicipio").value||"").trim() || d.municipio;
    d.rio = ($("detRio").value||"").trim() || d.rio;
    d.freguesia = ($("detFreg").value||"").trim();
    d.localidade = ($("detLoc").value||"").trim();
    d.caixa_visita = ($("detCV").value||"").trim();

    const lat=n2($("detLat").value); const lng=n2($("detLng").value);
    if(Number.isFinite(lat)) d.lat=+lat.toFixed(6);
    if(Number.isFinite(lng)) d.lng=+lng.toFixed(6);

    const lvl=n2($("detLevel").value);
    if(Number.isFinite(lvl)) d.level_pct=clamp(Math.round(lvl),0,100);

    const fl=n2($("detFlow").value);
    if(Number.isFinite(fl)) d.flow_lps=+(Math.max(0,fl).toFixed(1));

    // SCADA link (admin-managed)
    try{
      if(isAdmin() && $("detScadaUrl")){
        const su = ($("detScadaUrl").value||"").trim();
        d.scada_url = su ? su : "";
      }
    }catch(e){}

    d.status = $("detStatus").value || d.status;
    d.install_date = $("detInstall").value || "";
    d.purchase_date = $("detPurchase").value || "";

    if(kind==="datalogger"){
      const bd=n2($("detBatDays").value);
      if(Number.isFinite(bd)){
        const prev=Number(d.battery_days_left ?? bd);
        d.battery_days_left = Math.max(0, Math.floor(bd));
        if(d.battery_days_left !== prev) d.battery_last_update = Date.now();
        if(!d.battery_last_update) d.battery_last_update = Date.now();
      }

    }

    // limites (mín./máx.) — gravar (Caudalímetros + Data Logger's)
    if(kind==="datalogger" || kind==="caudal"){
      const lmin=n2($("detLevelMin")?.value);
      const lmax=n2($("detLevelMax")?.value);
      if(Number.isFinite(lmin)) d.level_min_pct = clamp(+lmin.toFixed(1), 0, 100); else d.level_min_pct = null;
      if(Number.isFinite(lmax)) d.level_max_pct = clamp(+lmax.toFixed(1), 0, 100); else d.level_max_pct = null;

      const fmin=n2($("detFlowMin")?.value);
      const fmax=n2($("detFlowMax")?.value);
      if(Number.isFinite(fmin)) d.flow_min_m3 = +(Math.max(0,fmin).toFixed(3)); else d.flow_min_m3 = null;
      if(Number.isFinite(fmax)) d.flow_max_m3 = +(Math.max(0,fmax).toFixed(3)); else d.flow_max_m3 = null;
    }

    if(kind==="caudal"){
      d.mc_type = $("detMC").value || d.mc_type;
    }

    saveDevice(kind, d);
    if(isNew){
      audit("ADD_DEVICE", `${kind}:${d.id}`);
      try{ delete window.__pendingDevices[pendingKey]; }catch(e){}
    }else{
      audit("EDIT_DEVICE", `${kind}:${d.id}`);
    }
    // update marker
    renderMapMarkers();
    renderDashboard();
    closeModal();
  });

  // Manual SCADA pull (admin)
  $("btnScadaNow")?.addEventListener("click", async ()=>{
    if(!isAdmin()) return;
    const url = ($("detScadaUrl")?.value||"").trim();
    if(url){ d.scada_url = url; saveDevice(kind, d); }
    const res = await fetchScadaForDevice(kind, d);
    if(!res.ok){
      alert("Não foi possível atualizar via SCADA. Verifique o link e permissões CORS.");
      return;
    }
    // refresh fields in the modal (latest values)
    const list = kind==="datalogger" ? getDL() : getC();
    const cur = list.find(x=>x.id===d.id);
    if(cur){
      if($("detLevel")) $("detLevel").value = cur.level_pct ?? "";
      if($("detFlow")) $("detFlow").value = cur.flow_lps ?? "";
    }
    try{ renderDeviceChart(kind, d.id); }catch(e){}
    audit("SCADA_PULL", `${kind}:${d.id}`);
  });

  $("btnDeleteDev")?.addEventListener("click", ()=>{
    confirmBox("Eliminar equipamento", `Eliminar ${d.name}? Esta ação só pode ser feita por Administrador.`, ()=>{
      deleteDevice(kind, d.id);
      audit("DELETE_DEVICE", `${kind}:${d.id}`);
      closeModal();
    });
  });
};

function renderLogList(items, admin, prefix){
  if(!items || !items.length) return `<div class="muted small">Sem registos.</div>`;
  return `<div class="tablewrap"><table class="table"><thead><tr><th>Data/Hora</th><th>Descrição</th>${admin?'<th></th>':""}</tr></thead><tbody>` +
    items.map((it,idx)=>`
      <tr>
        <td>${fmtDT(it.t)}</td>
        <td>${escapeHtml(it.text)}</td>
        ${admin?`<td><button class="btn danger" data-del="${prefix}:${idx}">Eliminar</button></td>`:""}
      </tr>
    `).join("") + `</tbody></table></div>`;
}
function wireLogDelete(kind, dev, prefix, containerId){
  const el=$(containerId);
  if(!el) return;
  qa('button[data-del^="'+prefix+':"]', el).forEach(btn=>{
    btn.onclick=()=>{
      const idx=Number(btn.dataset.del.split(":")[1]);
      if(!Number.isFinite(idx)) return;
      confirmBox("Eliminar registo", "Tem a certeza?", ()=>{
        if(prefix==="mnt") dev.maintenance.splice(idx,1);
        if(prefix==="bat") dev.battery_changes.splice(idx,1);
        saveDevice(kind, dev);
        audit("DELETE_LOG", `${kind}:${dev.id}:${prefix}`);
        el.innerHTML = renderLogList(prefix==="mnt"?dev.maintenance:dev.battery_changes, true, prefix);
        wireLogDelete(kind, dev, prefix, containerId);
      });
    };
  });
}
function renderInspections(list, admin){
  if(!list || !list.length) return `<div class="muted small">Sem inspeções.</div>`;
  return list.map((it,idx)=>{
    const photos = (it.photos||[]).map((p,i)=>`
      <a href="${p.dataUrl}" target="_blank" rel="noopener" class="muted small">${escapeHtml(p.name||("foto"+(i+1)))}</a>
    `).join(" • ");
    return `
      <div class="panel" style="margin-top:10px">
        <div class="toolbar" style="justify-content:space-between">
          <div><b>${fmtDT(it.t)}</b></div>
          ${admin?`<button class="btn danger" data-inspdel="${idx}">Eliminar</button>`:""}
        </div>
        <div>${escapeHtml(it.text||"")}</div>
        ${photos?`<div class="muted small" style="margin-top:6px">Fotos: ${photos}</div>`:""}
      </div>
    `;
  }).join("");
}
function wireInspectionDelete(kind, dev){
  qa('button[data-inspdel]').forEach(btn=>{
    btn.onclick=()=>{
      const idx=Number(btn.dataset.inspdel);
      confirmBox("Eliminar inspeção", "Tem a certeza?", ()=>{
        dev.inspections.splice(idx,1);
        saveDevice(kind, dev);
        audit("DELETE_INSPECTION", `${kind}:${dev.id}`);
        $("inspList").innerHTML = renderInspections(dev.inspections, true);
        wireInspectionDelete(kind, dev);
      });
    };
  });
}
function fileToDataURL(file){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onload=()=>resolve(String(r.result));
    r.onerror=reject;
    r.readAsDataURL(file);
  });
}

function saveDevice(kind, dev){
  const list = kind==="datalogger" ? getDL() : getC();
  const idx = list.findIndex(x=>x.id===dev.id);
  if(idx>=0) list[idx]=dev;
  else list.unshift(dev);
  if(kind==="datalogger") setDL(list); else setC(list);

  try{ histDeviceOptions(true); }catch(e){}
  try{ if($("tabHistorico") && $("tabHistorico").classList.contains("active")) renderHistorico(); }catch(e){}
  try{ renderMapMarkers(); }catch(e){}
  try{ renderDashboard(); }catch(e){}
  try{ renderDLTable(); }catch(e){}
  try{ renderCTable(); }catch(e){}
}
function deleteDevice(kind, id){
  if(kind==="datalogger"){
    setDL(getDL().filter(x=>x.id!==id));
  }else{
    setC(getC().filter(x=>x.id!==id));
  }
  renderMapMarkers();
  renderDashboard();
  try{ histDeviceOptions(true); }catch(e){}
  try{ renderHistorico(); }catch(e){}
  renderDLTable();
  renderCTable();
}

/* ---------- Tables: add/edit ---------- */
let dlEditMode=false, cEditMode=false;

function renderDLTable(){
  const tbody = q("#tblDL tbody");
  const list = getDL();
  const canEdit = canEditKind("datalogger");
  tbody.innerHTML = list.map(d=>`
    <tr>
      <td>${cell(d.name, "name", d.id, "datalogger")}</td>
      <td>${cell(d.municipio, "municipio", d.id, "datalogger")}</td>
      <td>${cell(d.rio, "rio", d.id, "datalogger")}</td>
      <td>${cell(d.caixa_visita, "caixa_visita", d.id, "datalogger")}</td>
      <td>${cell(d.level_pct, "level_pct", d.id, "datalogger", "number")}</td>
      <td>${cell(d.flow_lps, "flow_lps", d.id, "datalogger", "number", "0.1")}</td>
      <td>${cell(d.status==="ativo"?"Sim":"Não", "status", d.id, "datalogger")}</td>
      <td>
        <button class="btn" onclick="window.openDevice('datalogger','${d.id}')">Abrir</button>
        ${isAdmin()?`<button class="btn danger" onclick="window.deleteRow('datalogger','${d.id}')">Eliminar</button>`:""}
      </td>
    </tr>
  `).join("");
  if(canEdit && dlEditMode){
    wireCellEditing("datalogger");
  }
}
function renderCTable(){
  const tbody = q("#tblC tbody");
  const list = getC();
  const canEdit = canEditKind("caudal");
  tbody.innerHTML = list.map(d=>`
    <tr>
      <td>${cell(d.name, "name", d.id, "caudal")}</td>
      <td>${cell(d.municipio, "municipio", d.id, "caudal")}</td>
      <td>${cell(d.rio, "rio", d.id, "caudal")}</td>
      <td>${cell(d.caixa_visita, "caixa_visita", d.id, "caudal")}</td>
      <td>${cell(d.level_pct, "level_pct", d.id, "caudal", "number")}</td>
      <td>${cell(d.flow_lps, "flow_lps", d.id, "caudal", "number", "0.1")}</td>
      <td>${cell(d.status==="ativo"?"Sim":"Não", "status", d.id, "caudal")}</td>
      <td>
        <button class="btn" onclick="window.openDevice('caudal','${d.id}')">Abrir</button>
        ${isAdmin()?`<button class="btn danger" onclick="window.deleteRow('caudal','${d.id}')">Eliminar</button>`:""}
      </td>
    </tr>
  `).join("");
  if(canEdit && cEditMode){
    wireCellEditing("caudal");
  }
}
function cell(value, key, id, kind, type="text", step=""){
  const edit = (kind==="datalogger" ? dlEditMode : cEditMode);
  if(!edit) return escapeHtml(value);
  const canEdit = canEditKind(kind);
  if(!canEdit) return escapeHtml(value);
  if(key==="status"){
    const v = (String(value).toLowerCase().includes("sim") || String(value).toLowerCase()==="ativo") ? "ativo" : "inativo";
    return `<select class="input" data-cell="${kind}:${id}:${key}">
      <option value="ativo" ${v==="ativo"?"selected":""}>Ativo</option>
      <option value="inativo" ${v==="inativo"?"selected":""}>Inativo</option>
    </select>`;
  }
  if(type==="number"){
    return `<input class="input" type="number" ${step?`step="${step}"`:""} data-cell="${kind}:${id}:${key}" value="${escapeHtml(value)}">`;
  }
  return `<input class="input" data-cell="${kind}:${id}:${key}" value="${escapeHtml(value)}">`;
}

function wireCellEditing(kind){
  qa(`[data-cell^="${kind}:"]`).forEach(inp=>{
    inp.addEventListener("change", ()=>{
      const [k, id, key] = inp.dataset.cell.split(":");
      const list = (k==="datalogger") ? getDL() : getC();
      const idx = list.findIndex(x=>x.id===id);
      if(idx<0) return;
      const d=list[idx];
      let v = inp.value;
      if(key==="level_pct") v = clamp(Math.round(Number(v)||0),0,100);
      if(key==="flow_lps") v = +(Math.max(0, Number(v)||0)).toFixed(1);
      if(key==="status") v = (v==="ativo"?"ativo":"inativo");
      d[key]=v;
      list[idx]=d;
      if(k==="datalogger") setDL(list); else setC(list);
      audit("EDIT_CELL", `${k}:${id}:${key}`);
      renderMapMarkers();
      renderDashboard();
    });
  });
}

window.deleteRow = function(kind, id){
  confirmBox("Eliminar", "Tem a certeza que quer eliminar este equipamento?", ()=>{
    if(!isAdmin()){ alert("Apenas Administrador pode eliminar."); return; }
    deleteDevice(kind==="datalogger"?"datalogger":"caudal", id);
  });
};

function addDevice(kind){
  if(!canEditKind(kind)){ alert("Sem permissões."); return; }
  const cfg=getCfg();
  const munis=cfg.municipios||DEFAULT_MUNICIPIOS;
  const rios=cfg.rios||DEFAULT_RIOS;
  const d = {
    id: `${kind==="datalogger"?"DL":"C"}-${Date.now()}`,
    name: kind==="datalogger" ? "DL-NOVO" : "C-NOVO",
    municipio: munis[0]||"Guimarães",
    rio: rios[0]||"Rio Ave",
    caixa_visita: kind==="datalogger" ? "CV-DL-NOVO" : "CV-C-NOVO",
    sim: kind==="datalogger" ? "93" : "",
    lat: 41.4444,
    lng: -8.2962,
    level_pct: 0,
    flow_lps: 0.0,
    status: "ativo",
    imei: "",
    install_date: "",
    purchase_date: "",
    battery_changes: [],
    mc_type: kind==="caudal" ? "Eletromagnética" : "",
    freguesia: "",
    localidade: "",
    maintenance: [],
    inspections: []
  };
  // Não criar já em storage: apenas abrir o modal. Só grava quando carregar em "Guardar".
  window.__pendingDevices = window.__pendingDevices || {};
  window.__pendingDevices[`${kind}:${d.id}`] = d;
  window.openDevice(kind, d.id, { isNew:true });
}


/* ---------- Users ---------- */
function renderUsers(){
  const tbody=q("#tblUsers tbody");
  const users=load(LS.users, []);
  tbody.innerHTML = users.map(u=>`
    <tr>
      <td>${escapeHtml(u.name||"")}</td>
      <td>${escapeHtml(u.email||"")}</td>
      <td>${escapeHtml(u.phone||"")}</td>
      <td>${escapeHtml(u.role||"")}</td>
      <td>
        <button class="btn" onclick="window.editUser('${escapeHtml(u.id||"")}')">Editar</button>
        ${isAdmin() && u.email.toLowerCase()!==ADMIN_EMAIL.toLowerCase() ? `<button class="btn danger" onclick="window.deleteUser('${escapeHtml(u.id||"")}')">Eliminar</button>` : ""}
      </td>
    </tr>
  `).join("");
}

function openUserEditorModal(u, users, idx, isNew){
  openModal(isNew?"Novo utilizador":"Editar utilizador", `
    <div class="panel">
      <div class="toolbar">
        <div style="flex:1"><div class="muted small">Nome</div><input class="input" id="uName" value="${escapeHtml(u.name||"")}" /></div>
        <div style="flex:1"><div class="muted small">Telemóvel</div><input class="input" id="uPhone" value="${escapeHtml(u.phone||"")}" /></div>
      </div>
      <div class="toolbar">
        <div style="flex:1"><div class="muted small">Email</div><input class="input" id="uEmail" value="${escapeHtml(u.email||"")}" ${isNew?"":"readonly"} /></div>
        <div style="flex:1">
          <div class="muted small">Password</div>
          <div class="passrow">
            <input class="input" id="uPass" type="password" value="${escapeHtml(u.password||"")}" />
            <button class="eye" type="button" data-eye="uPass">👁</button>
          </div>
        </div>
      </div>
      <div class="toolbar">
        <div style="flex:1">
          <div class="muted small">Tipo</div>
          <select class="input" id="uRole">
            ${ROLES.map(r=>`<option value="${r}" ${u.role===r?"selected":""}>${r}</option>`).join("")}
          </select>
        </div>
        <div style="flex:2">
          <div class="muted small">Permissões</div>
          <div class="toolbar" style="margin:6px 0 0 0">
            ${PERM_OPTIONS.map(p=>`
              <label class="chk"><input type="checkbox" class="uPerm" value="${p.value}" ${ (u.perms||[]).includes(p.value) ? "checked":"" }> ${p.label}</label>
            `).join("")}
          </div>
        </div>
      </div>
      <div class="toolbar" style="justify-content:flex-end">
        <button class="btn" id="btnUSave" type="button">Guardar</button>
      </div>
    </div>
  `);
  wireEyes();
  recoverInit();

  $("btnUSave").onclick=()=>{
    const name=($("uName").value||"").trim();
    const phone=($("uPhone").value||"").trim();
    const email=($("uEmail").value||"").trim();
    const pass=($("uPass").value||"").trim();
    const role=$("uRole").value;
    const perms = qa(".uPerm").filter(x=>x.checked).map(x=>x.value);

    if(!email){ alert("Email é obrigatório."); return; }

    // Para novo utilizador, validar unicidade do email
    if(isNew){
      const exists = (users||[]).some(x=>String(x.email||"").toLowerCase()===String(email||"").toLowerCase());
      if(exists){ alert("Já existe um utilizador com esse email."); return; }
    }

    u.name=name; u.phone=phone; u.email=email; u.password=pass; u.role=role; u.perms=perms;

    if(u.email.toLowerCase()===ADMIN_EMAIL.toLowerCase()){
      u.role="Administrador";
      u.perms=[PERMS.VIEW, PERMS.EDIT, PERMS.ADMIN, PERMS.DELETE];
      u.password=ADMIN_PASS;
    }

    if(isNew){
      // Só aqui é que gravamos o novo utilizador
      u.id = u.id || ("u-"+uuid());
      users.push(u);
      audit("ADD_USER", u.email);
    } else {
      if(idx>=0) users[idx]=u;
      audit("EDIT_USER", u.email);
    }

    // Supabase Auth user creation (best-effort) for new users
    try{
      if(isNew && sbEnabled() && pass){
        sbAuthSignUp(email, pass, { name }).then(()=>{}).catch(()=>{});
      }
    }catch(e){}

    save(LS.users, users);
    closeModal();
    renderUsers();
  };
}


window.editUser = function(uid){
  if(!isAdmin()){ alert("Apenas Administrador."); return; }
  const users=load(LS.users, []);
  const idx=users.findIndex(x=>x.id===uid);
  const u=users[idx];
  if(!u) return;
  openUserEditorModal(u, users, idx, false);
};

window.deleteUser = function(uid){
  if(!isAdmin()){ alert("Apenas Administrador."); return; }
  const users=load(LS.users, []);
  const u=users.find(x=>x.id===uid);
  if(!u) return;
  confirmBox("Eliminar utilizador", `Eliminar ${u.email}?`, ()=>{
    const next = users.filter(x=>x.id!==uid);
    save(LS.users, next);
    audit("DELETE_USER", u.email);
    renderUsers();
  });
};

function addUser(){
  if(!isAdmin()){ alert("Apenas Administrador."); return; }
  const users=load(LS.users, []);
  const u = { id:"", name:"", email:"", phone:"", password:"", role:"Colaborador", perms:[PERMS.VIEW,"dash_view","dl_view","c_view","hist_view"] };
  // NÃO grava ao clicar em "Adicionar utilizador". Só grava ao carregar em "Guardar".
  openUserEditorModal(u, users, -1, true);
}


/* ---------- Audit view ---------- */
const actionLabels={LOGIN:'Login efetuado',LOGOUT:'Logout',DEVICE_EDIT:'Alteração de equipamento',AUDIT_DELETE_ONE:'Eliminação de registo',USERS_UPDATE:'Alteração de utilizadores'};

async function renderAudit(){
  const tbody=q("#tblAudit tbody");
  let list=load(LS.audit, []);

  // Prefer Supabase if configured (so the histórico de utilizadores appears across devices).
  try{
    const cfg=getSbCfg();
    if(cfg && cfg.url && cfg.anon){
      const rows = await sbSelect((cfg.audit_log||"audit_log"), { select:"ts,user,action,detail,meta", order:"ts.desc", limit:2000 });
      if(Array.isArray(rows)){
        // Normalize to the same structure used locally.
        list = rows.map(r=>({ ts:r.ts, user:r.user, action:r.action, detail:r.detail, meta:r.meta||{} }))
          .filter(x=>x.ts);
      }
    }
  }catch(e){ /* fall back to local */ }

  // Apenas o que o utilizador pediu: entradas/saídas e edições.
  const isEditAction = (a)=>{
    const s=String(a||"").toUpperCase();
    if(s==="CFG_SAVE") return true;
    if(s==="EDIT_CELL") return true;
    if(s==="EDIT_DEVICE" || s==="DEVICE_EDIT") return true;
    if(s==="EDIT_USER" || s==="USERS_EDIT") return true;
    return s.includes("EDIT");
  };

  // Guardamos o índice original para permitir eliminar registo a registo.
  const filtered = list
    .map((e,i)=>({e,i}))
    .filter(({e})=>{
      const a=String(e?.action||"").toUpperCase();
      return a==="LOGIN" || a==="LOGOUT" || isEditAction(a);
    });

  // If list is already newest-first from Supabase, keep it as-is. If local, show newest first.
  const ordered = (Array.isArray(list) && list.length && String(list[0]?.ts||"") > String(list[list.length-1]?.ts||"")) ? filtered : filtered.slice().reverse();

  const rows = ordered.map(({e,i})=>{
    const a=String(e.action||"").toUpperCase();
    const tipo = a==="LOGIN" ? "Entrada" : (a==="LOGOUT" ? "Saída" : "Edição");
    const edited = (a==="LOGIN" || a==="LOGOUT") ? "" : (describeAuditEntry(e) || e.detail || e.action || "");
    const delBtn = isAdmin() ? `<button class="btn danger" type="button" data-audit-del="${i}" data-audit-ts="${escapeHtml(String(e.ts||""))}" data-audit-user="${escapeHtml(String(e.user||""))}" data-audit-action="${escapeHtml(String(e.action||""))}">Eliminar</button>` : "";
    return `<tr>
      <td>${escapeHtml(fmtDT(e.ts||""))}</td>
      <td>${escapeHtml(e.user||"")}</td>
      <td>${escapeHtml(tipo)}</td>
      <td>${escapeHtml(edited)}</td>
      <td>${delBtn}</td>
    </tr>`;
  }).join("");

  tbody.innerHTML = rows || `<tr><td colspan="5" class="muted">Sem registos.</td></tr>`;

  // Handlers de eliminação por registo (apenas Admin).
  qa("[data-audit-del]", tbody).forEach(btn=>{
    btn.onclick=()=>{
      if(!isAdmin()){ alert("Apenas Administrador."); return; }
      const idx = Number(btn.dataset.auditDel);
      if(!Number.isFinite(idx)) return;
      const ts = btn.dataset.auditTs || "";
      const user = btn.dataset.auditUser || "";
      const action = btn.dataset.auditAction || "";
      confirmBox("Eliminar registo", "Eliminar este registo do histórico? (irreversível)", ()=>{
        // Delete locally
        const cur=load(LS.audit, []);
        if(Number.isFinite(idx) && idx>=0 && idx<cur.length){
          cur.splice(idx,1);
          save(LS.audit, cur);
        }
        // Delete in Supabase (best-effort). We match by ts+user+action to avoid wiping more than intended.
        try{
          const cfg=getSbCfg();
          if(cfg && cfg.url && cfg.anon && ts){
            sbDelete((cfg.audit_log||"audit_log"), { ts, user, action }).catch(()=>{});
          }
        }catch(e){}
        // não mostramos este evento no histórico (filtro), mas fica registado.
        audit("AUDIT_DELETE_ONE", String(idx));
        renderAudit();
      });
    };
  });
}

/* ---------- Config ---------- */
function renderConfig(){
  const cfg=getCfg();
  $("cfgAlertLevelOn").checked = !!cfg.alerts?.level_on;
  $("cfgAlertLevel").value = cfg.alerts?.level ?? 90;
  $("cfgAlertFlowOn").checked = !!cfg.alerts?.flow_on;
  $("cfgAlertFlow").value = cfg.alerts?.flow ?? 90;
  $("cfgAlertEmail").checked = !!cfg.alerts?.email;
  $("cfgAlertSMS").checked = !!cfg.alerts?.sms;
  $("cfgAlertEmailTo").value = cfg.alerts?.email_to ?? "";
  $("cfgAlertSMSTo").value = cfg.alerts?.sms_to ?? "";
  $("cfgExtOn").checked = !!cfg.alerts?.external_on;
  $("cfgExtUrl").value = cfg.alerts?.external_url ?? "";
  $("cfgExtMethod").value = cfg.alerts?.external_method || "POST";
  $("cfgExtToken").value = cfg.alerts?.external_token ?? "";

  const munis=cfg.municipios||[];
  $("listMunicipios").innerHTML = munis.map(m=>`
    <div class="chip">${escapeHtml(m)} ${isAdmin()?`<button class="btn danger" type="button" data-delmun="${escapeHtml(m)}">X</button>`:""}</div>
  `).join("") || `<div class="muted small">Sem municípios.</div>`;

  const rios=cfg.rios||[];
  $("listRios").innerHTML = rios.map(r=>`
    <div class="chip">${escapeHtml(r)} ${isAdmin()?`<button class="btn danger" type="button" data-delrio="${escapeHtml(r)}">X</button>`:""}</div>
  `).join("") || `<div class="muted small">Sem rios.</div>`;

  qa("[data-delmun]").forEach(btn=>{
    btn.onclick=()=>{
      if(!isAdmin()) return;
      const val=btn.dataset.delmun;
      confirmBox("Eliminar município", `Eliminar ${val}?`, ()=>{
        const cfg=getCfg();
        cfg.municipios = (cfg.municipios||[]).filter(x=>x!==val);
        setCfg(cfg);
        audit("CFG_DEL_MUNICIPIO", val);
        renderConfig();
      });
    };
  });
  qa("[data-delrio]").forEach(btn=>{
    btn.onclick=()=>{
      if(!isAdmin()) return;
      const val=btn.dataset.delrio;
      confirmBox("Eliminar rio/interceptor", `Eliminar ${val}?`, ()=>{
        const cfg=getCfg();
        cfg.rios = (cfg.rios||[]).filter(x=>x!==val);
        setCfg(cfg);
        audit("CFG_DEL_RIO", val);
        renderConfig();
      });
    };
  });

  try{
    // Populate integration fields from saved configs (so they persist after reload)
    try{
      const sb = getSbCfg();
      if($("cfgSupabaseUrl")) $("cfgSupabaseUrl").value = sb.url || "";
      if($("cfgSupabaseAnon")) $("cfgSupabaseAnon").value = sb.anon || "";
      if($("cfgSbTableDevices")) $("cfgSbTableDevices").value = (sb.devices || "devices");
      if($("cfgSbTableTelemetry")) $("cfgSbTableTelemetry").value = (sb.telemetry || "telemetry");
    }catch(e){}
    try{
      const cc = getCollectorCfg();
      if($("cfgCollectorUrl")) $("cfgCollectorUrl").value = cc.url || "";
      if($("cfgCollectorToken")) $("cfgCollectorToken").value = cc.token || "";
    }catch(e){}

    if($("btnCfgTestSupabase")) $("btnCfgTestSupabase").onclick = async ()=>{
      try{
        setSbCfg({
          url: ($("cfgSupabaseUrl")?.value||"").trim(),
          anon: ($("cfgSupabaseAnon")?.value||"").trim(),
          devices: ($("cfgSbTableDevices")?.value||"devices").trim(),
          telemetry: ($("cfgSbTableTelemetry")?.value||"telemetry").trim()
        });
        const sb=getSbCfg();
        await sbRequest((sb.devices||"devices")+"?select=id&limit=1");
        alert("Supabase: ligação OK.");
      }catch(e){
        alert("Supabase: falha. " + (e?.message||e));
      }
    };
    if($("btnCfgTestCollector")) $("btnCfgTestCollector").onclick = async ()=>{
      try{
        setCollectorCfg({ url: ($("cfgCollectorUrl")?.value||"").trim(), token: ($("cfgCollectorToken")?.value||"").trim() });
        const cc=getCollectorCfg();
        const res = await fetch(cc.url.replace(/\/$/,"") + "/health", { headers: cc.token?{"Authorization":cc.token}:{} });
        if(!res.ok) throw new Error("HTTP "+res.status);
        alert("Collector: ligação OK.");
      }catch(e){
        alert("Collector: falha. " + (e?.message||e));
      }
    };
  }catch(e){}
}

/* ---------- Historico view ---------- */
let _histLastKind = null;
function histDeviceOptions(force=false){
  const kind=$("histKind").value;
  const sel=$("histDevice");
  const prev=sel.value;
  if(!force && _histLastKind===kind && sel.options.length>0) return;
  let opts=[];
  if(kind==="datalogger") opts=getDL().map(d=>({id:String(d.id),label:d.name}));
  else if(kind==="caudal") opts=getC().map(d=>({id:String(d.id),label:d.name}));
  else {
    // Meteorologia: permitir escolher a localidade (com base no histórico e na localidade configurada)
    const h=getHist();
    const cfg=getCfg();
    const names=new Set();
    const cfgName=(cfg.weatherLocation && cfg.weatherLocation.name) ? String(cfg.weatherLocation.name).trim() : "";
    if(cfgName) names.add(cfgName);
    // keys do store local (adngest_meteo_hist_v1)
    try{
      const store = getMeteoHistStore();
      const ks = Object.keys((store && store.locs) ? store.locs : {});
      ks.forEach(k=>{ if(k && k!=="DEFAULT") names.add(String(k)); });
    }catch(e){}

    (h.meteo||[]).forEach(x=>{ if(x && x.city) names.add(String(x.city)); });
    const arr = Array.from(names).filter(Boolean).sort((a,b)=>a.localeCompare(b,"pt"));
    opts = arr.length ? arr.map(n=>({id:n,label:n})) : [{id:(cfgName||"Meteorologia"),label:(cfgName||"Meteorologia")}];
  }
  sel.innerHTML = opts.map(o=>`<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}</option>`).join("");
  if(prev && opts.find(o=>o.id===prev)) sel.value = prev;
  _histLastKind = kind;
}




function aggregate(points, unit, isMeteo){
  // points: [{t, level_pct, flow_lps, p_mm_h, ...}]
  // unit: minute/hour/day/week/month/year based on t bucket.
  const buckets=new Map();

  const stepMs = (unit==="minute") ? 60000 :
                 (unit==="hour")   ? 3600000 :
                 (unit==="day")    ? 86400000 :
                 (unit==="week")   ? 7*86400000 :
                 // month/year are approximate for end ranges; used only for deletes.
                 (unit==="month")  ? 31*86400000 :
                 (unit==="year")   ? 366*86400000 : 60000;

  for(const p of (points||[])){
    const tt = new Date(p.t).getTime();
    if(!Number.isFinite(tt)) continue;
    const dt=new Date(tt);
    let key="";

    if(unit==="minute"){
      key = dt.toISOString().slice(0,16); // YYYY-MM-DDTHH:MM
    }else if(unit==="hour"){
      key = dt.toISOString().slice(0,13); // YYYY-MM-DDTHH
    }else if(unit==="day"){
      key = dt.toISOString().slice(0,10);
    }else if(unit==="week"){
      // ISO week (UTC)
      const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
      const dayNum = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - dayNum + 3);
      const firstThursday = new Date(Date.UTC(d.getUTCFullYear(),0,4));
      const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3) / 7);
      key = `${d.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;
    }else if(unit==="month"){
      key = dt.toISOString().slice(0,7);
    }else if(unit==="year"){
      key = dt.toISOString().slice(0,4);
    }else{
      key = dt.toISOString().slice(0,16);
    }

    if(!buckets.has(key)){
      buckets.set(key, { t:key, n:0, level:0, flow:0, p:0, flow_liters:0, rain_mm:0, min_ms:tt, max_ms:tt });
    }
    const b=buckets.get(key);
    b.n++;
    b.level += Number(p.level_pct||0);
    b.flow  += Number(p.flow_lps||0);

    const pp = Number(p.p_mm_h||0);
    b.p += pp;

    // totals
    // - DL/C: points are samples; treat as 1-minute samples when exporting totals (legacy behavior)
    // - Meteo: hourly precipitation is already per-hour mm; we treat pp as mm for that sample
    b.flow_liters += Number(p.flow_lps||0) * 60;
    b.rain_mm += isMeteo ? pp : (pp/60);

    if(tt < b.min_ms) b.min_ms = tt;
    if(tt > b.max_ms) b.max_ms = tt;
  }

  const arr = Array.from(buckets.values())
    .sort((a,b)=>a.t.localeCompare(b.t))
    .map(b=>({
      t: b.t,
      start_ms: b.min_ms,
      end_ms: b.max_ms + stepMs,
      level_pct: b.n? +(b.level/b.n).toFixed(1) : null,
      flow_lps:  b.n? +(b.flow/b.n).toFixed(1) : null,
      p_mm_h:    isMeteo ? +b.p.toFixed(2) : (b.n? +(b.p/b.n).toFixed(2) : null),
      flow_total_m3: +( (b.flow_liters/1000).toFixed(3) ),
      p_total_mm: +b.rain_mm.toFixed(2)
    }));

  return arr;
}




function getHistorySeries(){
  const kind=$("histKind").value;
  const id=$("histDevice").value;
  const agg=$("histAgg").value;
  const range=Number($("histRange").value);
  const dayStr = ($("histDate") && $("histDate").value) ? $("histDate").value : "";
  const h=getHist();
  let points=[];

  const since = (range===0) ? null : Date.now() - range*60000;

  if(kind==="datalogger"){
    points = (h.dl[id]||[]);
  }else if(kind==="caudal"){
    points = (h.c[id]||[]);
  }else{
    // Meteorologia: preferir série horária em cache (Open-Meteo) para garantir gráfico/tabela completos.
    const city = id;
    const cache = getMeteoCache();
    let fromCache = null;
    if(city){
      for(const k of Object.keys(cache||{})){
        const it = cache[k];
        if(!it) continue;
        const nm = String(it.name||k||"");
        if(String(city)===String(k) || String(city)===nm){
          const times = (it.hourly && it.hourly.time) ? it.hourly.time : [];
          const prec  = (it.hourly && (it.hourly.precipitation||it.hourly.precip)) ? (it.hourly.precipitation||it.hourly.precip) : [];
          if(Array.isArray(times) && Array.isArray(prec) && times.length){
            fromCache = times.map((t,i)=>({ t, p_mm_h: (prec[i] ?? null), level_pct:null, flow_lps:null }));
          }
        }
      }
    }
    if(fromCache){
      points = fromCache;
    }else{
      // Fallback 1: store diário (adngest_meteo_hist_v1)
      try{
        const store = getMeteoHistStore();
        const arr = (store && store.locs && city && Array.isArray(store.locs[city])) ? store.locs[city] : null;
        if(arr && arr.length){
          points = arr.map(d=>({
            t: d.t,
            p_mm_h: (Number(d.rain_mm||0)/24),
            p_total_mm: Number(d.rain_mm||0),
            level_pct:null,
            flow_lps:null
          }));
        }
      }catch(e){}
      if(points && points.length){
        // ok
      }else{
      // Fallback: snapshots do histórico
      points = (h.meteo||[])
        .filter(x=> !city || (String(x.city||"")===String(city)) )
        .map(x=>({t:x.t, p_mm_h:x.p_mm_h, p_total_mm:x.p_total_mm??null, level_pct:null, flow_lps:null}));
      }
    }
  }

  // Specific day overrides range
  if(dayStr){
    const start = new Date(dayStr+"T00:00:00");
    const end = new Date(start.getTime() + 24*60*60*1000);
    points = points.filter(p=>{
      const tt = new Date(p.t).getTime();
      return tt>=start.getTime() && tt<end.getTime();
    });
  }else if(since){
    points = points.filter(p=>new Date(p.t).getTime()>=since);
  }

  return aggregate(points, agg, kind==='meteo');
}


function ensureHistoricoData(){
  // Ensure there is at least 1 year of local data for each device so Histórico never shows empty.
  try{
    const h=getHist();
    h.dl = h.dl || {};
    h.c  = h.c  || {};
    const days = 365;
    const dls = getDL();
    const cs  = getC();

    // Ensure meteo store has at least one locality series (synthetic if needed)
    let store = {};
    try{ store = JSON.parse(localStorage.getItem("adngest_meteo_hist_v1")||"{}"); }catch(e){ store={}; }
    store.locs = store.locs || {};
    const ensureLoc = (loc)=>{
      const key=(loc||"").trim() || "DEFAULT";
      if(!Array.isArray(store.locs[key]) || store.locs[key].length<160){
        // daily rain series
        const arr=[];
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        start.setDate(start.getDate() - (days-1));
        // wet/dry spells
        let regime = Math.random() < 0.5;
        for(let i=0;i<days;i++){
          const day = new Date(start.getTime() + i*86400000);
          if(Math.random()<0.10) regime = !regime;
          const wet = regime ? (Math.random()<0.70) : (Math.random()<0.20);
          let mm = 0;
          if(wet){
            mm = Math.pow(Math.random(),0.35) * (10 + Math.random()*25);
            if(Math.random()<0.07) mm += 20 + Math.random()*40;
          }
          arr.push({ t: day.getTime(), rain_mm: Number(mm.toFixed(2)) });
        }
        store.locs[key]=arr;
      }
      return key;
    };

    // ensure locs for all devices
    dls.forEach(d=>ensureLoc(d.localidade||d.municipio||""));
    cs.forEach(c=>ensureLoc(c.localidade||c.municipio||""));
    ensureLoc("DEFAULT");
    try{ localStorage.setItem("adngest_meteo_hist_v1", JSON.stringify(store)); }catch(e){}

    const getRain = (loc)=>{
      const key=(loc||"").trim();
      if(key && Array.isArray(store.locs[key])) return store.locs[key];
      const ks = Object.keys(store.locs||{});
      if(ks.length && Array.isArray(store.locs[ks[0]])) return store.locs[ks[0]];
      return [];
    };

    // Build correlated device series (hourly points) using rain series
    const buildSeries = (seedStr, rainDaily)=>{
      // Expand daily rain into hourly buckets
      const step = 60*60*1000;
      const _nowD=new Date(); _nowD.setMinutes(0,0,0);
      const now = _nowD.getTime();
      const n = Math.floor(days*24);
      let hseed=2166136261;
      for(let i=0;i<seedStr.length;i++){ hseed ^= seedStr.charCodeAt(i); hseed = Math.imul(hseed, 16777619); }
      const rand=()=>{ hseed ^= hseed<<13; hseed ^= hseed>>>17; hseed ^= hseed<<5; return ((hseed>>>0)/4294967296); };
      const rainByDay = {};
      (rainDaily||[]).forEach(p=>{ rainByDay[Math.floor(p.t/86400000)] = Number(p.rain_mm||0); });
      let wet=0;
      const baseL=25+rand()*20;
      const baseF=1+rand()*4;
      const evap=0.06+rand()*0.05;
      const kL=1.8+rand()*1.2;
      const kF=0.45+rand()*0.35;
      const out=[];
      for(let i=n-1;i>=0;i--){
        const t = now - i*step;
        const dayKey=Math.floor(t/86400000);
        const mm = rainByDay[dayKey] || 0;
        // distribute mm across 24 buckets/day
        const bucketRain = mm/24;
        wet += bucketRain*1.0;
        wet *= (1-evap);
        wet = Math.min(50, Math.max(0, wet));
        const diurnal=Math.sin((t/86400000)*Math.PI*2)*(1.2+rand()*0.6);
        let lvl = baseL + wet*kL + diurnal + (rand()-0.5)*3.0;
        let flow = baseF + wet*kF + Math.max(0, bucketRain*0.15) + (rand()-0.5)*0.7;
        lvl=Math.min(99,Math.max(1,lvl));
        flow=Math.max(0,flow);
        out.push({ t, level_pct:Number(lvl.toFixed(1)), flow_lps:Number(flow.toFixed(2)) });
      }
      return out;
    };

    dls.forEach(d=>{
      const id=d.id;
      if(!Array.isArray(h.dl[id]) || h.dl[id].length<40){
        const loc=(d.localidade||d.municipio||"");
        h.dl[id] = buildSeries("dl:"+id+":"+loc, getRain(loc));
      }
      // Seed to Supabase (only once) so Histórico is also stored remotely
      try{ if(sbEnabled()) void sbSeedTelemetryOnceFromLocal("datalogger", id, h.dl[id]).catch(()=>{}); }catch(e){}
      // update current snapshot for map/dashboard
      const last = h.dl[id][h.dl[id].length-1];
      if(last){ d.level_pct = last.level_pct; d.flow_lps = last.flow_lps; }
    });

    cs.forEach(c=>{
      const id=c.id;
      if(!Array.isArray(h.c[id]) || h.c[id].length<40){
        const loc=(c.localidade||c.municipio||"");
        h.c[id] = buildSeries("c:"+id+":"+loc, getRain(loc));
      }
      // Seed to Supabase (only once) so Histórico is also stored remotely
      try{ if(sbEnabled()) void sbSeedTelemetryOnceFromLocal("caudal", id, h.c[id]).catch(()=>{}); }catch(e){}
      const last = h.c[id][h.c[id].length-1];
      if(last){ c.level_pct = last.level_pct; c.flow_lps = last.flow_lps; }
    });

    setHist(h);
    setDL(dls);
    setC(cs);
  }catch(e){}
}

function renderHistorico(){
  try{ ensureHistoricoData(); }catch(e){}
  startMeteoDrivenUpdates();

  histDeviceOptions(false);
  const kind=$('histKind')?.value || 'datalogger';
  const id=$('histDevice')?.value || '';
  // If Supabase is configured, lazily load telemetry for the selected device into local history.
  try{
    if(sbEnabled() && kind!=="meteo" && id){
      sbEnsureTelemetry(kind, id, ()=>{ try{ renderHistorico(); }catch(e){} });
    }
  }catch(e){}

  const series=getHistorySeries();

  // table
  const tbody=q('#tblHist tbody');
  const rows = series.slice().reverse().slice(0,2000).map(r=>{
    // Mantemos a grelha estável para os 3 tipos (DL/C/Meteo)
    const lvl = (r.level_pct===null || r.level_pct===undefined) ? '—' : escapeHtml(String(r.level_pct));
    const flow = (r.flow_lps===null || r.flow_lps===undefined) ? '—' : escapeHtml(String(r.flow_lps));
    const flowTot = (r.flow_total_m3===null || r.flow_total_m3===undefined) ? '—' : escapeHtml(String(r.flow_total_m3));
    const p = (r.p_mm_h===null || r.p_mm_h===undefined) ? '—' : escapeHtml(String(r.p_mm_h));
    const pTot = (r.p_total_mm===null || r.p_total_mm===undefined) ? '—' : escapeHtml(String(r.p_total_mm));
    const delBtn = isAdmin()? `<button class="btn danger" data-hdel="1" data-hdel-start="${escapeHtml(String(r.start_ms||0))}" data-hdel-end="${escapeHtml(String(r.end_ms||0))}">Eliminar</button>` : '';
    return `      <tr>        <td>${escapeHtml(String(r.t))}</td>        <td>${lvl}</td>        <td>${flow}</td>        <td>${flowTot}</td>        <td>${p}</td>        <td>${pTot}</td>        <td>${delBtn}</td>      </tr>    `;
  }).join('');
  tbody.innerHTML = rows || `<tr><td colspan="7" class="muted small">Sem dados.</td></tr>`;

  // chart: desenhar apenas quando o canvas já tiver layout/width válidos
  scheduleHistoricoChartDraw(series);
}

// ---- Robust rendering for Histórico chart (prevents "missing chart" when switching devices/tabs)
let __histDrawPending = null;
let __histResizeObs = null;
let __histVisibilityHooked = false;
function scheduleHistoricoChartDraw(series){
  __histDrawPending = series;
  const canvas = $("histChart");
  if(!canvas) return;

  const attempt = ()=>{
    const s = __histDrawPending;
    if(!s) return;
    if(_ensureCanvasRenderable(canvas, attempt)){
      // Only clear pending after a successful draw *with real layout*.
      // If the canvas is still effectively hidden (width/height ~ 0), keep pending.
      try{
        const ok = drawHistChart(s);
        if(ok) __histDrawPending = null;
      }catch(e){
        // Keep pending so a later resize/visibility/layout pass can redraw.
        requestAnimationFrame(()=> setTimeout(attempt, 80));
      }
    }
  };

  // Use rAF + micro delay to wait for DOM/layout to settle after changes
  requestAnimationFrame(()=> setTimeout(attempt, 0));
  requestAnimationFrame(()=> setTimeout(attempt, 120));

  // If the tab is hidden at the moment we schedule, a ResizeObserver will re-attempt
  if(!__histResizeObs && canvas.parentElement){
    try{
      __histResizeObs = new ResizeObserver(()=>{
        if(__histDrawPending) requestAnimationFrame(attempt);
      });
      __histResizeObs.observe(canvas.parentElement);
    }catch(e){}
  }

  // Redraw when page/tab becomes visible again.
  if(!__histVisibilityHooked){
    __histVisibilityHooked = true;
    try{
      document.addEventListener("visibilitychange", ()=>{
        if(document.visibilityState === "visible" && __histDrawPending){
          requestAnimationFrame(()=> setTimeout(attempt, 60));
        }
      });
    }catch(e){}
  }
}

function drawDashChart(series, kind, title){
  const canvas=$("dashChart");
  if(!canvas) return;
  const ctx=canvas.getContext("2d");
  const dpr=window.devicePixelRatio||1;

  // Use the *rendered* size (CSS pixels) to avoid "desconfigurado" charts when
  // the canvas is resized or when tabs/devices are switched.
  const cssW = (canvas.getBoundingClientRect && canvas.getBoundingClientRect().width) ? canvas.getBoundingClientRect().width : (canvas.clientWidth || canvas.parentElement?.clientWidth || 0);
  const cssH = (canvas.getBoundingClientRect && canvas.getBoundingClientRect().height) ? canvas.getBoundingClientRect().height : (canvas.clientHeight || Number(canvas.getAttribute("height")) || 0);
  const W = Math.max(340, Math.round(cssW||0));
  const H = Math.max(180, Math.round(cssH||0));

  // If we still don't have a real size (hidden tab), don't clear pending.
  if(W < 80 || H < 60){
    return false;
  }

  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);

  // Draw in CSS pixels (stable), then scale by DPR.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0,0,W,H);

  if(!series || series.length<1){
    ctx.fillStyle="rgba(2,6,23,.72)";
    ctx.font = `15px system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText("Sem dados suficientes para gráfico.", 12, 24);
    return true;
  }

  const kindSel = kind || "datalogger";

  // For Histórico:
  // - DL/C: plot **both** Nível (%) + Caudal (m³)
  // - Meteo: plot Precipitação (mm/h)
  const isMeteo = false;

  // Data extraction (keep NaN for missing values so we can detect availability)
  const lvlVals  = series.map(p=> Number(p.level_pct ?? NaN));
  const flowVals = series.map(p=> Number(p.flow_lps ?? NaN));
  const metVals  = series.map(p=> Number(p.p_mm_h ?? 0));

  const hasLvl  = !isMeteo && lvlVals.some(v=>isFinite(v));
  const hasFlow = !isMeteo && flowVals.some(v=>isFinite(v));

  // If DL/C has neither level nor flow, nothing to draw.
  if(!isMeteo && !hasLvl && !hasFlow){
    ctx.fillStyle="rgba(2,6,23,.72)";
    ctx.font = `15px system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText("Sem dados suficientes para gráfico.", 12, 24);
    return true;
  }

  // Compute Y scales.
  // Requirement: charts must never show negative ticks; axes start at 0 and the
  // maximum is determined by the data (no fixed ceiling).
  const finiteMinMax = (arr, fallbackMin=0, fallbackMax=1)=>{
    const finite = arr.filter(v=>isFinite(v));
    if(!finite.length) return {min: 0, max: Math.max(1, fallbackMax)};
    let mn = Math.min(...finite), mx = Math.max(...finite);
    if(!isFinite(mn) || !isFinite(mx)) return {min: 0, max: Math.max(1, fallbackMax)};
    if(mx===mn) mx = mn + 1;
    const pad = (mx - mn) * 0.08;
    let max = mx + pad;
    if(!isFinite(max) || max<=0) max = Math.max(1, fallbackMax);
    return {min: 0, max};
  };

  const yL = hasLvl ? finiteMinMax(lvlVals, 0, 100) : {min:0, max:100};
  const yR = hasFlow ? finiteMinMax(flowVals, 0, 10)  : {min:0, max:10};
  const yM = isMeteo ? (()=>{ const mm = finiteMinMax(metVals, 0, 10); mm.min = 0; mm.max = Math.max(10, mm.max); return mm; })() : null;

  // background (subtle card look)
  ctx.fillStyle = "rgba(255,255,255,.94)";
  ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = "rgba(2,6,23,.10)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5,0.5,W-1,H-1);

  // Dynamic paddings to keep labels readable at smaller sizes
  // Reserve space on the right for a secondary Y axis when Flow exists.
  const padL = 64;
  const padR = (hasFlow && !isMeteo) ? 64 : 18;
  const padT = 38;
  const padB = 52;

  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const denom = Math.max(1, (series.length - 1));
  const xAt = (i)=> padL + iw * (i / denom);
  const scale = (v, min, max)=> (max===min) ? 0.5 : ((v - min) / (max - min));

  const yAtL = (v)=> padT + ih * (1 - scale(v, yL.min, yL.max));
  const yAtR = (v)=> padT + ih * (1 - scale(v, yR.min, yR.max));
  const yAtM = (v)=> padT + ih * (1 - scale(v, yM.min, yM.max));

  // grid + axes
  ctx.strokeStyle = "rgba(2,6,23,.14)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for(let i=0;i<=4;i++){
    const y = padT + ih * (i/4);
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + iw, y);
  }
  // left axis
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + ih);
  // right axis (only if dual-axis)
  if(hasFlow && !isMeteo){
    ctx.moveTo(padL + iw, padT);
    ctx.lineTo(padL + iw, padT + ih);
  }
  ctx.stroke();

  // y labels (left)
  ctx.fillStyle = "rgba(2,6,23,.88)";
  ctx.font = `16px system-ui, -apple-system, Segoe UI, Roboto`;
  for(let i=0;i<=4;i++){
    const v = (isMeteo ? (yM.max - (yM.max-yM.min)*(i/4)) : (yL.max - (yL.max-yL.min)*(i/4)));
    const y = padT + ih*(i/4);
    const txt = isFinite(v) ? v.toFixed( (isMeteo? 1 : 1) ) : "—";
    ctx.fillText(txt, 10, y+6);
  }

  // y labels (right) for flow
  if(hasFlow && !isMeteo){
    ctx.fillStyle = "rgba(2,6,23,.72)";
    ctx.font = `16px system-ui, -apple-system, Segoe UI, Roboto`;
    for(let i=0;i<=4;i++){
      const v = yR.max - (yR.max-yR.min)*(i/4);
      const y = padT + ih*(i/4);
      const txt = isFinite(v) ? v.toFixed(1) : "—";
      const tw = ctx.measureText(txt).width;
      ctx.fillText(txt, W - 10 - tw, y+6);
    }
  }


  // axis titles (identify left/right scales) — keep outside the plot and clean.
  try{
    ctx.font = `12px system-ui, -apple-system, Segoe UI, Roboto`;
    const yTitleY = 26;
    if(isMeteo){
      const t = "Precipitação (mm/h)";
      ctx.fillStyle = "rgba(37,99,235,.92)";
      ctx.fillText(t, 10, yTitleY);
    }else{
      if(hasLvl){
        const t="Nível (%)";
        ctx.fillStyle="rgba(212,175,55,.98)";
        ctx.fillText(t, 10, yTitleY);
      }
      if(hasFlow){
        const t="Caudal (m³)";
        ctx.fillStyle="rgba(16,185,129,.95)";
        const tw = ctx.measureText(t).width;
        ctx.fillText(t, W - 10 - tw, yTitleY);
      }
    }
  }catch(e){}

  // x labels (few ticks)
  try{
    const want = Math.min(6, series.length);
    ctx.fillStyle = "rgba(2,6,23,.72)";
    ctx.font = `13px system-ui, -apple-system, Segoe UI, Roboto`;
    for(let k=0;k<want;k++){
      const i = Math.round(k * (series.length-1) / Math.max(1,(want-1)));
      const t = String(series[i]?.t||"");
      const lbl = t.length>16 ? t.slice(5,16).replace('T',' ') : t;
      const x = xAt(i);
      const y = padT + ih + 32;
      const tw = ctx.measureText(lbl).width;
      ctx.fillText(lbl, Math.min(padL+iw-tw, Math.max(padL, x - tw/2)), y);
    }
  }catch(e){}

  // helper: draw a line (optionally with subtle area fill)
  const drawLine = (vals, yFn, strokeCol, fillCol)=>{
    if(!vals || !vals.some(v=>isFinite(v))) return;
    // area fill
    if(fillCol){
      ctx.beginPath();
      let started=false;
      for(let i=0;i<vals.length;i++){
        const v=vals[i];
        if(!isFinite(v)) continue;
        const x=xAt(i), y=yFn(v);
        if(!started){ ctx.moveTo(x,y); started=true; }
        else ctx.lineTo(x,y);
      }
      if(started){
        ctx.lineTo(xAt(vals.length-1), padT+ih);
        ctx.lineTo(xAt(0), padT+ih);
        ctx.closePath();
        ctx.fillStyle = fillCol;
        ctx.fill();
      }
    }

    // line
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    let started=false;
    for(let i=0;i<vals.length;i++){
      const v=vals[i];
      if(!isFinite(v)) continue;
      const x=xAt(i), y=yFn(v);
      if(!started){ ctx.moveTo(x,y); started=true; }
      else ctx.lineTo(x,y);
    }
    if(started) ctx.stroke();

    // points
    ctx.fillStyle = "rgba(2,6,23,.92)";
    for(let i=0;i<vals.length;i++){
      const v=vals[i];
      if(!isFinite(v)) continue;
      const x=xAt(i), y=yFn(v);
      ctx.beginPath();
      ctx.arc(x,y,2.6,0,Math.PI*2);
      ctx.fill();
    }
  };

  if(isMeteo){
    drawLine(metVals, yAtM, "rgba(37,99,235,.92)", "rgba(37,99,235,.18)");
  }else{
    // Level (left axis)
    if(hasLvl) drawLine(lvlVals, yAtL, "rgba(212,175,55,.98)", "rgba(212,175,55,.18)");
    // Flow (right axis)
    if(hasFlow) drawLine(flowVals, yAtR, "rgba(16,185,129,.95)", "rgba(16,185,129,.14)");
  }

  // legend (with color keys)
  const sw = 10, sh = 10;
  let lx = padL;
  const ly = 8;
  ctx.font = `12px system-ui, -apple-system, Segoe UI, Roboto`;
  ctx.fillStyle = "rgba(2,6,23,.82)";
  const putLegend = (col, text)=>{
    ctx.fillStyle = col; ctx.fillRect(lx, ly, sw, sh);
    ctx.fillStyle = "rgba(2,6,23,.82)";
    ctx.fillText(text, lx + sw + 6, 17);
    lx += sw + 6 + ctx.measureText(text).width + 18;
  };
  if(isMeteo){
    putLegend("rgba(37,99,235,.92)", "Precipitação (mm/h)");
  }else{
    if(hasLvl)  putLegend("rgba(212,175,55,.98)", "Nível (%)");
    if(hasFlow) putLegend("rgba(16,185,129,.95)", "Caudal (m³)");
  }

  // Title disabled on Dashboard

  
  // Brand mark
  try{
    ctx.save();
    ctx.fillStyle = "rgba(2,6,23,.55)";
    ctx.font = `12px system-ui, -apple-system, Segoe UI, Roboto`;
    const brand = "M.T®";
    const tw = ctx.measureText(brand).width;
    ctx.fillText(brand, W - 10 - tw, H - 10);
    ctx.restore();
  }catch(e){}
return true;
}

function drawHistChart(series){
  const canvas=$("histChart");
  if(!canvas) return;
  const ctx=canvas.getContext("2d");
  const dpr=window.devicePixelRatio||1;

  // Use the *rendered* size (CSS pixels) to avoid "desconfigurado" charts when
  // the canvas is resized or when tabs/devices are switched.
  const cssW = (canvas.getBoundingClientRect && canvas.getBoundingClientRect().width) ? canvas.getBoundingClientRect().width : (canvas.clientWidth || canvas.parentElement?.clientWidth || 0);
  const cssH = (canvas.getBoundingClientRect && canvas.getBoundingClientRect().height) ? canvas.getBoundingClientRect().height : (canvas.clientHeight || Number(canvas.getAttribute("height")) || 0);
  const W = Math.max(340, Math.round(cssW||0));
  const H = Math.max(180, Math.round(cssH||0));

  // If we still don't have a real size (hidden tab), don't clear pending.
  if(W < 80 || H < 60){
    return false;
  }

  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);

  // Draw in CSS pixels (stable), then scale by DPR.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0,0,W,H);

  if(!series || series.length<1){
    ctx.fillStyle="rgba(2,6,23,.72)";
    ctx.font = `15px system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText("Sem dados suficientes para gráfico.", 12, 24);
    return true;
  }

  const kind=$("histKind")?.value || "datalogger";

  // For Histórico:
  // - DL/C: plot **both** Nível (%) + Caudal (m³)
  // - Meteo: plot Precipitação (mm/h)
  const isMeteo = kind==="meteo";

  // Data extraction (keep NaN for missing values so we can detect availability)
  const lvlVals  = series.map(p=> Number(p.level_pct ?? NaN));
  const flowVals = series.map(p=> Number(p.flow_lps ?? NaN));
  const metVals  = series.map(p=> Number(p.p_mm_h ?? 0));

  const hasLvl  = !isMeteo && lvlVals.some(v=>isFinite(v));
  const hasFlow = !isMeteo && flowVals.some(v=>isFinite(v));

  // If DL/C has neither level nor flow, nothing to draw.
  if(!isMeteo && !hasLvl && !hasFlow){
    ctx.fillStyle="rgba(2,6,23,.72)";
    ctx.font = `15px system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText("Sem dados suficientes para gráfico.", 12, 24);
    return true;
  }

  // Compute Y scales.
  // Requirement: charts must never show negative ticks; axes start at 0 and the
  // maximum is determined by the data (no fixed ceiling).
  const finiteMinMax = (arr, fallbackMin=0, fallbackMax=1)=>{
    const finite = arr.filter(v=>isFinite(v));
    if(!finite.length) return {min: 0, max: Math.max(1, fallbackMax)};
    let mn = Math.min(...finite), mx = Math.max(...finite);
    if(!isFinite(mn) || !isFinite(mx)) return {min: 0, max: Math.max(1, fallbackMax)};
    if(mx===mn) mx = mn + 1;
    const pad = (mx - mn) * 0.08;
    let max = mx + pad;
    if(!isFinite(max) || max<=0) max = Math.max(1, fallbackMax);
    return {min: 0, max};
  };

  const yL = hasLvl ? finiteMinMax(lvlVals, 0, 100) : {min:0, max:100};
  const yR = hasFlow ? finiteMinMax(flowVals, 0, 10)  : {min:0, max:10};
  const yM = isMeteo ? (()=>{ const mm = finiteMinMax(metVals, 0, 10); mm.min = 0; mm.max = Math.max(1, mm.max); return mm; })() : null;

  // background (subtle card look)
  ctx.fillStyle = "rgba(255,255,255,.94)";
  ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = "rgba(2,6,23,.10)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5,0.5,W-1,H-1);

  // Dynamic paddings to keep labels readable at smaller sizes
  // Reserve space on the right for a secondary Y axis when Flow exists.
  const padL = 64;
  const padR = (hasFlow && !isMeteo) ? 64 : 18;
  const padT = 38;
  const padB = 52;

  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const denom = Math.max(1, (series.length - 1));
  const xAt = (i)=> padL + iw * (i / denom);
  const scale = (v, min, max)=> (max===min) ? 0.5 : ((v - min) / (max - min));

  const yAtL = (v)=> padT + ih * (1 - scale(v, yL.min, yL.max));
  const yAtR = (v)=> padT + ih * (1 - scale(v, yR.min, yR.max));
  const yAtM = (v)=> padT + ih * (1 - scale(v, yM.min, yM.max));

  // grid + axes
  ctx.strokeStyle = "rgba(2,6,23,.14)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for(let i=0;i<=4;i++){
    const y = padT + ih * (i/4);
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + iw, y);
  }
  // left axis
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + ih);
  // right axis (only if dual-axis)
  if(hasFlow && !isMeteo){
    ctx.moveTo(padL + iw, padT);
    ctx.lineTo(padL + iw, padT + ih);
  }
  ctx.stroke();

  // y labels (left)
  ctx.fillStyle = "rgba(2,6,23,.88)";
  ctx.font = `16px system-ui, -apple-system, Segoe UI, Roboto`;
  for(let i=0;i<=4;i++){
    const v = (isMeteo ? (yM.max - (yM.max-yM.min)*(i/4)) : (yL.max - (yL.max-yL.min)*(i/4)));
    const y = padT + ih*(i/4);
    const txt = isFinite(v) ? v.toFixed( (isMeteo? 1 : 1) ) : "—";
    ctx.fillText(txt, 10, y+6);
  }

  // y labels (right) for flow
  if(hasFlow && !isMeteo){
    ctx.fillStyle = "rgba(2,6,23,.72)";
    ctx.font = `16px system-ui, -apple-system, Segoe UI, Roboto`;
    for(let i=0;i<=4;i++){
      const v = yR.max - (yR.max-yR.min)*(i/4);
      const y = padT + ih*(i/4);
      const txt = isFinite(v) ? v.toFixed(1) : "—";
      const tw = ctx.measureText(txt).width;
      ctx.fillText(txt, W - 10 - tw, y+6);
    }
  }


  // axis titles (identify left/right scales) — keep outside the plot and clean.
  try{
    ctx.font = `12px system-ui, -apple-system, Segoe UI, Roboto`;
    const yTitleY = 26;
    if(isMeteo){
      const t = "Precipitação (mm/h)";
      ctx.fillStyle = "rgba(37,99,235,.92)";
      ctx.fillText(t, 10, yTitleY);
    }else{
      if(hasLvl){
        const t="Nível (%)";
        ctx.fillStyle="rgba(212,175,55,.98)";
        ctx.fillText(t, 10, yTitleY);
      }
      if(hasFlow){
        const t="Caudal (m³)";
        ctx.fillStyle="rgba(16,185,129,.95)";
        const tw = ctx.measureText(t).width;
        ctx.fillText(t, W - 10 - tw, yTitleY);
      }
    }
  }catch(e){}

  // x labels (few ticks)
  try{
    const want = Math.min(6, series.length);
    ctx.fillStyle = "rgba(2,6,23,.72)";
    ctx.font = `13px system-ui, -apple-system, Segoe UI, Roboto`;
    for(let k=0;k<want;k++){
      const i = Math.round(k * (series.length-1) / Math.max(1,(want-1)));
      const t = String(series[i]?.t||"");
      const lbl = t.length>16 ? t.slice(5,16).replace('T',' ') : t;
      const x = xAt(i);
      const y = padT + ih + 32;
      const tw = ctx.measureText(lbl).width;
      ctx.fillText(lbl, Math.min(padL+iw-tw, Math.max(padL, x - tw/2)), y);
    }
  }catch(e){}

  // helper: draw a line (optionally with subtle area fill)
  const drawLine = (vals, yFn, strokeCol, fillCol)=>{
    if(!vals || !vals.some(v=>isFinite(v))) return;
    // area fill
    if(fillCol){
      ctx.beginPath();
      let started=false;
      for(let i=0;i<vals.length;i++){
        const v=vals[i];
        if(!isFinite(v)) continue;
        const x=xAt(i), y=yFn(v);
        if(!started){ ctx.moveTo(x,y); started=true; }
        else ctx.lineTo(x,y);
      }
      if(started){
        ctx.lineTo(xAt(vals.length-1), padT+ih);
        ctx.lineTo(xAt(0), padT+ih);
        ctx.closePath();
        ctx.fillStyle = fillCol;
        ctx.fill();
      }
    }

    // line
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    let started=false;
    for(let i=0;i<vals.length;i++){
      const v=vals[i];
      if(!isFinite(v)) continue;
      const x=xAt(i), y=yFn(v);
      if(!started){ ctx.moveTo(x,y); started=true; }
      else ctx.lineTo(x,y);
    }
    if(started) ctx.stroke();

    // points
    ctx.fillStyle = "rgba(2,6,23,.92)";
    for(let i=0;i<vals.length;i++){
      const v=vals[i];
      if(!isFinite(v)) continue;
      const x=xAt(i), y=yFn(v);
      ctx.beginPath();
      ctx.arc(x,y,2.6,0,Math.PI*2);
      ctx.fill();
    }
  };

  if(isMeteo){
    drawLine(metVals, yAtM, "rgba(37,99,235,.92)", "rgba(37,99,235,.18)");
  }else{
    // Level (left axis)
    if(hasLvl) drawLine(lvlVals, yAtL, "rgba(212,175,55,.98)", "rgba(212,175,55,.18)");
    // Flow (right axis)
    if(hasFlow) drawLine(flowVals, yAtR, "rgba(16,185,129,.95)", "rgba(16,185,129,.14)");
  }

  // legend (with color keys)
  const sw = 10, sh = 10;
  let lx = padL;
  const ly = 8;
  ctx.font = `12px system-ui, -apple-system, Segoe UI, Roboto`;
  ctx.fillStyle = "rgba(2,6,23,.82)";
  const putLegend = (col, text)=>{
    ctx.fillStyle = col; ctx.fillRect(lx, ly, sw, sh);
    ctx.fillStyle = "rgba(2,6,23,.82)";
    ctx.fillText(text, lx + sw + 6, 17);
    lx += sw + 6 + ctx.measureText(text).width + 18;
  };
  if(isMeteo){
    putLegend("rgba(37,99,235,.92)", "Precipitação (mm/h)");
  }else{
    if(hasLvl)  putLegend("rgba(212,175,55,.98)", "Nível (%)");
    if(hasFlow) putLegend("rgba(16,185,129,.95)", "Caudal (m³)");
  }

  // Title (top-right)
  try{
    const k = $("histKind")?.value || "datalogger";
    const dev = $("histDevice")?.value || "";
    let name = "";
    if(k==="datalogger") name = (getDL().find(d=>String(d.id)===String(dev))?.name||"");
    else if(k==="caudal") name = (getC().find(d=>String(d.id)===String(dev))?.name||"");
    else name = String(dev||"Meteorologia");
    const title = name ? name : (k==="meteo"?"Meteorologia":"");
    if(title){
      ctx.fillStyle = "rgba(2,6,23,.75)";
      ctx.font = `12px system-ui, -apple-system, Segoe UI, Roboto`;
      const tw = ctx.measureText(title).width;
      ctx.fillText(title, Math.max(padL + 120, W - tw - 10), 17);
    }
  }catch(e){}

  
  // Brand mark
  try{
    ctx.save();
    ctx.fillStyle = "rgba(2,6,23,.55)";
    ctx.font = `12px system-ui, -apple-system, Segoe UI, Roboto`;
    const brand = "M.T®";
    const tw = ctx.measureText(brand).width;
    ctx.fillText(brand, W - 10 - tw, H - 10);
    ctx.restore();
  }catch(e){}
return true;
}

function exportCSV(filename, rows){
  const csv = rows.map(r=>r.map(v=>{
    const s = (v===null||v===undefined) ? "" : String(v);
    const q = s.includes(",")||s.includes('"')||s.includes("\n");
    return q ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(",")).join("\n");
  const blob=new Blob([csv], {type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function exportHistoricoCSV(){
  const kind=$("histKind").value;
  const devId=$("histDevice").value;
  const devName = (kind==="datalogger" ? (getDL().find(d=>String(d.id)===String(devId))?.name||devId)
                 : kind==="caudal" ? (getC().find(c=>String(c.id)===String(devId))?.name||devId)
                 : "Meteorologia");
  const series=getHistorySeries();
  const rows=[["timestamp","level_pct","flow_m3","flow_total_m3","precip_mm_h","precip_total_mm"]]
    .concat(series.map(r=>[r.t,r.level_pct,r.flow_lps,r.flow_total_m3,r.p_mm_h,r.p_total_mm]));
  const safe = String(devName).replace(/[^a-z0-9]+/gi,"_").replace(/^_+|_+$/g,"").slice(0,40) || "selecionado";
  exportCSV(`historico_${kind}_${safe}.csv`, rows);
  audit("EXPORT_XLSX",`Excel/CSV: ${kind} ${devName}`);
}
function exportPDF(){
  const dayStr = ($("histDate") && $("histDate").value) ? $("histDate").value : "";
  const kind=$("histKind").value;
  const devId=$("histDevice").value;
  const devName = (kind==="datalogger" ? (getDL().find(d=>String(d.id)===String(devId))?.name||devId)
                 : kind==="caudal" ? (getC().find(c=>String(c.id)===String(devId))?.name||devId)
                 : "Meteorologia");
  const agg=$("histAgg").value;
  const range=$("histRange").value;
  const series=getHistorySeries();

  const title = `ADNGEST • Histórico (${kind}) • ${devName}` + (dayStr? ` • ${dayStr}`:"");
  const totalFlow = series.reduce((s,r)=> s + (Number(r.flow_lps)||0), 0);
  const totalPrecip = series.reduce((s,r)=> s + (Number(r.p_mm_h)||0), 0);
  const rows = series.slice().reverse().map(r=>`
    <tr>
      <td>${escapeHtml(r.t)}</td>
      <td>${r.level_pct===null? "—": escapeHtml(String(r.level_pct))}</td>
      <td>${r.flow_lps===null? "—": escapeHtml(String(r.flow_lps))}</td>
      <td>${r.flow_total_m3===null? "—": escapeHtml(String(r.flow_total_m3))}</td>
      <td>${r.p_mm_h===null? "—": escapeHtml(String(r.p_mm_h))}</td>
      <td>${r.p_total_mm===null? "—": escapeHtml(String(r.p_total_mm))}</td>
    </tr>`).join("") || `<tr><td colspan="6">Sem dados.</td></tr>`;

  const w = window.open("", "_blank");
  if(!w) return;
  w.document.open();
  w.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{ font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin:24px; color:#0f172a; }
  h1{ margin:0 0 6px; font-size:18px; }
  .meta{ margin:0 0 14px; color:#475569; font-size:12px; }
  table{ width:100%; border-collapse:collapse; font-size:12px; }
  th,td{ border:1px solid #cbd5e1; padding:6px 8px; text-align:left; }
  th{ background:#f1f5f9; }
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">Agregação: ${escapeHtml(agg)} • Intervalo: ${escapeHtml(range)} • Registos: ${series.length}</div>
<table>
  <thead><tr><th>Timestamp</th><th>Nível (%)</th><th>Caudal (m³)</th><th>Total (m³)</th><th>Precip. (mm/h)</th><th>Total (mm)</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<script>window.onload=()=>{ window.print(); };</script>
</body></html>`);
  w.document.close();
  audit("EXPORT_PDF",`PDF: ${kind} ${devName}`);
}


function historicoDeleteByRange(kind, id, start_ms, end_ms){
  if(!isAdmin()){ alert("Apenas Administrador."); return false; }
  const h=getHist();
  const s = Number(start_ms||0);
  const e = Number(end_ms||0);
  if(!(s>0) || !(e>s)){ return false; }

  const inRange = (pt)=>{
    const t = new Date(pt).getTime();
    return t>=s && t<e;
  };

  if(kind==="datalogger"){
    if(!h.dl || !h.dl[id]) return false;
    h.dl[id] = (h.dl[id]||[]).filter(p=>!inRange(p.t));
  }else if(kind==="caudal"){
    if(!h.c || !h.c[id]) return false;
    h.c[id] = (h.c[id]||[]).filter(p=>!inRange(p.t));
  }else if(kind==="meteo"){
    if(!Array.isArray(h.meteo)) return false;
    h.meteo = h.meteo.filter(p=>!inRange(p.t ?? p.ts ?? p.date));
  }else{
    return false;
  }
  setHist(h);

  // Supabase delete (best-effort)
  try{
    if(sbEnabled()){
      if(kind==="meteo") void sbDeleteMeteoByRange(id, s, e).catch(()=>{});
      else void sbDeleteTelemetryByRange(kind, id, s, e).catch(()=>{});
    }
  }catch(e){}
  return true;
}

let __histDelWired=false;
function wireHistoricoDeleteDelegation(){
  if(__histDelWired) return;
  __histDelWired=true;
  const tbody=q("#tblHist tbody");
  if(!tbody) return;
  tbody.addEventListener("click", (ev)=>{
    const btn = ev.target?.closest?.("button[data-hdel]");
    if(!btn) return;
    const kind = ($("histKind")?.value||"datalogger");
    const id = ($("histDevice")?.value||"");
    const s = btn.dataset.hdelStart;
    const e = btn.dataset.hdelEnd;
    confirmBox("Eliminar registo", "Tem a certeza que quer eliminar este registo?", ()=>{
      const ok = historicoDeleteByRange(kind, id, s, e);
      audit("DELETE_HISTORY_ROW", `${kind}:${id}:${s}-${e}`);
      if(!ok){ alert("Não foi possível eliminar (registo não encontrado)."); return; }
      renderHistorico();
    });
  });
}

function deleteHistorico(){
  if(!isAdmin()){ alert("Apenas Administrador pode eliminar histórico."); return; }
  const kind=$("histKind").value;
  const id=$("histDevice").value;
  confirmBox("Eliminar histórico", "Eliminar os dados selecionados? (opção irreversível)", ()=>{
    const h=getHist();
    if(kind==="datalogger"){ delete h.dl[id]; }
    else if(kind==="caudal"){ delete h.c[id]; }
    else { h.meteo=[]; }
    setHist(h);
    audit("DELETE_HISTORY", `${kind}:${id}`);

    // Supabase delete (best-effort)
    try{
      if(sbEnabled()){
        if(kind==="meteo") void sbDeleteAllMeteo(id).catch(()=>{});
        else void sbDeleteAllTelemetryForDevice(kind, id).catch(()=>{});
      }
    }catch(e){}

    renderHistorico();
  });
}

function _rangeForScope(scope, baseDateStr=""){
  const base = baseDateStr ? new Date(baseDateStr+"T12:00:00") : new Date();
  if(scope==="day"){
    const s = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
    return {start:s, end:s+86400000};
  }
  if(scope==="week"){
    // Monday-start week
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const day = (d.getDay()+6)%7; // Monday=0
    d.setDate(d.getDate()-day);
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return {start:s, end:s+7*86400000};
  }
  if(scope==="month"){
    const s = new Date(base.getFullYear(), base.getMonth(), 1).getTime();
    const e = new Date(base.getFullYear(), base.getMonth()+1, 1).getTime();
    return {start:s, end:e};
  }
  if(scope==="year"){
    const s = new Date(base.getFullYear(), 0, 1).getTime();
    const e = new Date(base.getFullYear()+1, 0, 1).getTime();
    return {start:s, end:e};
  }
  return null;
}

function deleteHistoricoScoped(){
  if(!isAdmin()){ alert("Apenas Administrador pode eliminar histórico."); return; }
  const kind=$("histKind").value;
  const id=$("histDevice").value;
  const scope = $("histDelScope")?.value || "day";
  if(scope==="always") return deleteHistorico();

  const dayStr = ($("histDate") && $("histDate").value) ? $("histDate").value : "";
  const rg = _rangeForScope(scope, dayStr);
  if(!rg) return;

  const label = scope==="day"?"dia":scope==="week"?"semana":scope==="month"?"mês":"ano";
  confirmBox("Eliminar histórico", `Eliminar dados do ${label} selecionado? (opção irreversível)`, ()=>{
    const h=getHist();
    const s=rg.start, e=rg.end;

    const inRange = (pt)=>{
      const t = new Date(pt).getTime();
      return t>=s && t<e;
    };

    if(kind==="datalogger"){
      if(h.dl && h.dl[id]) h.dl[id] = (h.dl[id]||[]).filter(p=>!inRange(p.t));
    }else if(kind==="caudal"){
      if(h.c && h.c[id]) h.c[id] = (h.c[id]||[]).filter(p=>!inRange(p.t));
    }else{
      // Meteo: remove by city from h.meteo as a best-effort; main meteo series comes from cache
      if(Array.isArray(h.meteo)){
        h.meteo = h.meteo.filter(p=>{
          if(String(p.city||"")!==String(id)) return true;
          return !inRange(p.t ?? p.ts ?? p.date);
        });
      }
    }
    setHist(h);
    audit("DELETE_HISTORY_SCOPE", `${kind}:${id}:${scope}:${s}-${e}`);

    // Supabase delete (best-effort)
    try{
      if(sbEnabled()){
        if(kind==="meteo") void sbDeleteMeteoByRange(id, s, e).catch(()=>{});
        else void sbDeleteTelemetryByRange(kind, id, s, e).catch(()=>{});
      }
    }catch(e){}

    renderHistorico();
  });
}


function histBucketKey(t, unit){
  const dt = new Date(t);
  if(unit==="raw") return String(t);
  if(unit==="minute") return dt.toISOString().slice(0,16);
  if(unit==="hour") return dt.toISOString().slice(0,13);
  if(unit==="day") return dt.toISOString().slice(0,10);
  if(unit==="month") return dt.toISOString().slice(0,7);
  if(unit==="year") return dt.toISOString().slice(0,4);
  if(unit==="week"){
    // same approximation used in aggregate()
    const d = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    const yy = d.getUTCFullYear();
    return `${yy}-W${String(weekNo).padStart(2,"0")}`;
  }
  return dt.toISOString().slice(0,10);
}

function wireHistoricoRowDelete(kind, id){
  const tbody = q("#tblHist tbody");
  if(!tbody) return;

  // Delegate by event to avoid missing newly rendered rows
  tbody.onclick = (ev)=>{
    const btn = ev.target && ev.target.closest ? ev.target.closest("button[data-hdel]") : null;
    if(!btn) return;
    if(!isAdmin()){ alert("Apenas Administrador."); return; }

    const key = String(btn.dataset.hdel||"");
    const agg = ($("histAgg")?.value || "raw");

    confirmBox("Eliminar registo", "Tem a certeza que quer eliminar este registo?", ()=>{
      const h=getHist();

      const removeByBucket = (arr)=>{
        if(!Array.isArray(arr)) return arr;
        if(agg==="raw"){
          // raw delete: key may be ms, ISO, or formatted; try multiple comparisons
          const matchPoint = (pt)=>{
            try{
              if(String(pt)===key) return true;
              if(fmtDT(pt)===key) return true;
              const iso = new Date(pt).toISOString();
              if(iso===key) return true;
            }catch(e){}
            return false;
          };
          return arr.filter(p=>!matchPoint(p.t));
        }
        // aggregated delete: remove all raw points that fall into the selected bucket key
        return arr.filter(p=>{
          try{ return histBucketKey(p.t, agg)!==key; }catch(e){ return true; }
        });
      };

      if(kind==="datalogger"){
        if(h.dl && h.dl[id]) h.dl[id] = removeByBucket(h.dl[id]);
      }else if(kind==="caudal"){
        if(h.c && h.c[id]) h.c[id] = removeByBucket(h.c[id]);
      }else if(kind==="meteo"){
        // meteo is not stored in h.meteo in this build; keep best-effort if present
        if(Array.isArray(h.meteo)){
          if(agg==="raw"){
            h.meteo = h.meteo.filter(p=>{
              const pt = (p.t ?? p.ts ?? p.date);
              try{
                if(String(pt)===key) return false;
                if(fmtDT(pt)===key) return false;
                const iso=new Date(pt).toISOString();
                if(iso===key) return false;
              }catch(e){}
              return true;
            });
          }else{
            h.meteo = h.meteo.filter(p=>{
              const pt = (p.t ?? p.ts ?? p.date);
              try{ return histBucketKey(pt, agg)!==key; }catch(e){ return true; }
            });
          }
        }
      }

      setHist(h);
      audit("DELETE_HISTORY_ROW", `${kind}:${id}:${key}:${agg}`);
      renderHistorico();
    });
  };
}



/* ---------- Exports / Audit actions ---------- */
function exportAuditCSV(){
  const list=load(LS.audit, []);

  const isEditAction = (a)=>{
    const s=String(a||"").toUpperCase();
    if(s==="CFG_SAVE") return true;
    if(s==="EDIT_CELL") return true;
    if(s==="EDIT_DEVICE" || s==="DEVICE_EDIT") return true;
    if(s==="EDIT_USER" || s==="USERS_EDIT") return true;
    return s.includes("EDIT");
  };

  const filtered = list.filter(e=>{
    const a=String(e?.action||"").toUpperCase();
    return a==="LOGIN" || a==="LOGOUT" || isEditAction(a);
  });

  const rows=[["data_hora","utilizador","entrada_saida","o_que_editou"]].concat(
    filtered.map(e=>{
      const a=String(e.action||"").toUpperCase();
      const tipo = a==="LOGIN" ? "Entrada" : (a==="LOGOUT" ? "Saída" : "Edição");
      const edited = (a==="LOGIN" || a==="LOGOUT") ? "" : (describeAuditEntry(e) || e.detail || e.action || "");
      return [
        fmtDT(e.ts||""),
        e.user||"",
        tipo,
        edited
      ];
    })
  );
  exportCSV("historico_utilizadores.csv", rows);
  audit("EXPORT_CSV","historico_utilizadores.csv");
}
function clearAudit(){
  if(!isAdmin()){ alert("Apenas Administrador."); return; }
  confirmBox("Eliminar histórico utilizadores", "Eliminar TODOS os registos? (irreversível)", ()=>{
    save(LS.audit, []);
    audit("CLEAR_AUDIT","");
    renderAudit();
  });
}

/* ---------- Config save ---------- */
function saveConfig(){
  if(!isAdmin()){ alert("Apenas Administrador."); return; }
  const cfg=getCfg();
  cfg.alerts = {
    level_on: $("cfgAlertLevelOn").checked,
    level: clamp(Number($("cfgAlertLevel").value||90),0,100),
    flow_on: $("cfgAlertFlowOn").checked,
    flow: clamp(Number($("cfgAlertFlow").value||90),0,999999),
    email: $("cfgAlertEmail").checked,
    email_to: (($("cfgAlertEmailTo").value)||"").trim(),
    sms: $("cfgAlertSMS").checked,
    sms_to: (($("cfgAlertSMSTo").value)||"").trim(),
    external_on: $("cfgExtOn").checked,
    external_url: (($("cfgExtUrl").value)||"").trim(),
    external_method: (($("cfgExtMethod").value)||"POST").toUpperCase(),
    external_token: (($("cfgExtToken").value)||"").trim()
  };
  setCfg(cfg);

  // Supabase + Collector (save always if fields exist)
  try{
    if($("cfgSupabaseUrl") && $("cfgSupabaseAnon")){
      setSbCfg({
        url: ($("cfgSupabaseUrl").value||"").trim(),
        anon: ($("cfgSupabaseAnon").value||"").trim(),
        devices: ($("cfgSbTableDevices")?.value||"devices").trim(),
        telemetry: ($("cfgSbTableTelemetry")?.value||"telemetry").trim()
      });
    }
    if($("cfgCollectorUrl")){
      setCollectorCfg({
        url: ($("cfgCollectorUrl").value||"").trim(),
        token: ($("cfgCollectorToken")?.value||"").trim()
      });
    }
  }catch(e){}

  audit("CFG_SAVE","alerts+integration");
  alert("Configurações guardadas.");
}

function addMunicipio(){
  if(!isAdmin()){ alert("Apenas Administrador."); return; }
  const v=($("newMunicipio").value||"").trim();
  if(!v) return;
  const cfg=getCfg();
  cfg.municipios = Array.from(new Set([...(cfg.municipios||[]), v]));
  setCfg(cfg);
  $("newMunicipio").value="";
  audit("CFG_ADD_MUNICIPIO", v);
  renderConfig();
}
function addRio(){
  if(!isAdmin()){ alert("Apenas Administrador."); return; }
  const v=($("newRio").value||"").trim();
  if(!v) return;
  const cfg=getCfg();
  cfg.rios = Array.from(new Set([...(cfg.rios||[]), v]));
  setCfg(cfg);
  $("newRio").value="";
  audit("CFG_ADD_RIO", v);
  renderConfig();
}

function testAlert(){
  if(!isAdmin()){ alert("Apenas Administrador."); return; }
  const cfg=getCfg();
  const a=cfg.alerts||{};
  const payload={
    alert:"TEST",
    timestamp: nowISO(),
    device_kind:"test",
    device_id:"test",
    device:"Teste",
    level_pct: Number(a.level ?? 90),
    flow_m3: Number(a.flow ?? 90),
    notify:{
      email: a.email ? (a.email_to||"") : "",
      phone: a.sms ? (a.sms_to||"") : ""
    }
  };
  audit("ALERT_TEST","config");
  if(a.external_on && String(a.external_url||"").trim()){
    void sendAlertExternal(payload, a);
    alert("Teste enviado (best effort) para o servidor externo. Verifique os logs do servidor / consola.");
  }else{
    alert("Teste preparado. Ative a integração com servidor externo e defina o URL para enviar.");
  }
}

/* ---------- Password eye ---------- */
function wireEyes(){
  // (v39) robust eye toggle

  // NOTE:
  // The application uses a single delegated click-handler (see bootApp) to toggle
  // password visibility for any button with [data-eye].
  // This function only normalizes the icon based on the current input type.
  qa("[data-eye]").forEach(btn=>{
    const id=btn.getAttribute("data-eye");
    const input=$(id);
    if(!input) return;
    btn.textContent = (input.type==="password") ? "👁" : "🙈";
  });
}

// Single delegated handler for password visibility toggles.
// Must work both on the login screen and inside modals.
function ensureEyeDelegate(){
  if(window.__eyeDelegate) return;
  window.__eyeDelegate = true;
  document.addEventListener('click', (e)=>{
    const btn = e.target && e.target.closest ? e.target.closest('[data-eye]') : null;
    if(!btn) return;
    const id = btn.getAttribute('data-eye');
    const input = document.getElementById(id);
    if(!input) return;
    input.type = (input.type === 'password') ? 'text' : 'password';
    btn.textContent = (input.type === 'password') ? '👁' : '🙈';
  });
}

/* ---------- Clock ---------- */
function startClock(){
  const tick=()=>{
    const now=new Date();
    $("nowClock").textContent = now.toLocaleString("pt-PT");
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------- SCADA integration (optional) ---------- */
// Each device may have: dev.scada_url (string). The URL should return JSON.
// Supported JSON formats:
//  - { timestamp, level_pct, flow_lps }  (single point)
//  - { data: { timestamp, level_pct, flow_lps } }
//  - [ { timestamp, level_pct, flow_lps }, ... ] (uses last element)
// If device_id is absent, the selected device id is assumed.

function _pickScadaPoint(json){
  if(!json) return null;
  if(Array.isArray(json)) return json.length? json[json.length-1] : null;
  if(typeof json === "object" && json.data && typeof json.data === "object") return json.data;
  if(typeof json === "object") return json;
  return null;
}

function _normalizeScadaPayload(kind, devId, point){
  if(!point || typeof point !== "object") return null;
  const t = point.timestamp || point.ts || point.time || point.datetime || nowISO();
  // Accept common key variants
  const level = (point.level_pct ?? point.level ?? point.nivel_pct ?? point.nivel);
  const flow  = (point.flow_lps ?? point.flow ?? point.caudal ?? point.caudal_m3 ?? point.flow_m3);
  // If flow is provided as m3/h or m3/s, we cannot infer reliably.
  // We assume the API returns the same unit used by the app (m³/h-ish label), stored in flow_lps field.
  const payload = {
    device_id: (point.device_id ?? point.id ?? devId),
    timestamp: t,
  };
  if(level !== undefined && level !== null && level !== "") payload.level_pct = Number(level);
  if(flow !== undefined && flow !== null && flow !== "") payload.flow_lps = Number(flow);
  return payload;
}

async function fetchScadaForDevice(kind, dev){
  const url = (dev && dev.scada_url) ? String(dev.scada_url).trim() : "";
  if(!url) return { ok:false, reason:"no_url" };
  try{
    const res = await fetch(url, { cache:"no-store" });
    if(!res.ok) return { ok:false, reason:`http_${res.status}` };
    const json = await res.json();
    const point = _pickScadaPoint(json);
    const payload = _normalizeScadaPayload(kind, dev.id, point);
    if(!payload) return { ok:false, reason:"bad_payload" };
    window.applyScadaUpdate(kind, payload);
    return { ok:true };
  }catch(e){
    return { ok:false, reason:"fetch_error" };
  }
}

async function fetchScadaForAll(kind){
  const list = kind==="datalogger" ? getDL() : getC();
  const withUrl = list.filter(d=>d.scada_url && String(d.scada_url).trim());
  if(!withUrl.length) return;
  for(const dev of withUrl){
    await fetchScadaForDevice(kind, dev);
  }
}

// SCADA manager UI (Admin)
function openScadaManager(kind){
  if(!isAdmin()){ alert("Apenas Administrador."); return; }
  const list = kind==="datalogger" ? getDL() : getC();
  const rows = list.map(d=>`
    <tr>
      <td>${escapeHtml(d.name)}</td>
      <td style="min-width:260px">
        <div class="muted small">Fonte</div>
        <select class="input" data-sourcesel="${kind}:${d.id}">
          <option value="manual" ${(!d.source_type||d.source_type==="manual")?"selected":""}>Manual / Local</option>
          <option value="scada_json" ${(d.source_type==="scada_json")?"selected":""}>SCADA (JSON URL)</option>
          <option value="krohne_gateway" ${(d.source_type==="krohne_gateway")?"selected":""}>KROHNE (via Gateway Modbus)</option>
          <option value="sofrel_web_ls" ${(d.source_type==="sofrel_web_ls")?"selected":""}>SOFREL WEB LS (Web Services)</option>
        </select>
        <div class="muted small" style="margin-top:6px">SCADA JSON URL (se aplicável)</div>
        <input class="input" data-scadaurl="${kind}:${d.id}" value="${escapeHtml(d.scada_url||"")}" placeholder="https://.../scada/${d.id}.json" />
        <div class="muted small" style="margin-top:6px">ID externo (tag/slave/id SOFREL)</div>
        <input class="input" data-extid="${kind}:${d.id}" value="${escapeHtml(d.external_id||"")}" placeholder="ex.: 12 | TAG_01 | WEBLS_123" />
        <div class="muted small" style="margin-top:6px">Collector URL (opcional; se vazio usa Configurações)</div>
        <input class="input" data-colurl="${kind}:${d.id}" value="${escapeHtml(d.collector_url||"")}" placeholder="https://gateway/api" />
      </td>
      <td style="white-space:nowrap">
        <button class="btn" data-scadapull="${kind}:${d.id}">Atualizar</button>
      </td>
    </tr>
  `).join("");

  openModal(`SCADA — ${kind==="datalogger"?"Data Logger's":"Caudalímetros"}`, `
    <div class="panel">
      <div class="muted small">Defina o link SCADA (JSON) por equipamento. Quando existir link, a aplicação passa a usar automaticamente os dados do SCADA (e pode atualizar manualmente).</div>
      <div class="tablewrap" style="margin-top:10px">
        <table class="table">
          <thead><tr><th>Equipamento</th><th>Link SCADA (JSON)</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="3" class="muted small">Sem equipamentos.</td></tr>`}</tbody>
        </table>
      </div>
      <div class="toolbar" style="justify-content:flex-end; margin-top:12px">
        <button class="btn" id="btnScadaFetchAll" type="button">Atualizar todos</button>
        <button class="btn" id="btnScadaSave" type="button">Guardar</button>
      </div>
      <div class="muted small" style="margin-top:10px">Formato esperado do JSON: <code>{ timestamp, level_pct, flow_lps }</code> (ou array de pontos; usa o último).</div>
    </div>
  `);

  // wire save
  $("btnScadaSave").onclick=()=>{
    const inputs = qa("[data-scadaurl]");
    const srcs = qa("[data-sourcesel]");
    const extids = qa("[data-extid]");
    const colurls = qa("[data-colurl]");
    const list2 = kind==="datalogger" ? getDL() : getC();
    for(const inp of inputs){
      const [k,id] = String(inp.dataset.scadaurl||"").split(":");
      if(k!==kind) continue;
      const idx = list2.findIndex(x=>String(x.id)===String(id));
      if(idx<0) continue;
      const v = (inp.value||"").trim();
      list2[idx].scada_url = v ? v : "";
      try{ const ss = srcs.find(x=>String(x.dataset.sourcesel||"")===`${kind}:${id}`); if(ss) list2[idx].source_type = ss.value||"manual"; }catch(e){}
      try{ const ee = extids.find(x=>String(x.dataset.extid||"")===`${kind}:${id}`); if(ee) list2[idx].external_id = (ee.value||"").trim(); }catch(e){}
      try{ const cc = colurls.find(x=>String(x.dataset.colurl||"")===`${kind}:${id}`); if(cc) list2[idx].collector_url = (cc.value||"").trim(); }catch(e){}
    }
    if(kind==="datalogger") setDL(list2); else setC(list2);
    audit("SCADA_LINKS_SAVE", kind);
    renderDLTable();
    renderCTable();
    renderDashboard();
    closeModal();
  };

  // wire per-row pull
  qa("[data-scadapull]").forEach(btn=>{
    btn.onclick=async ()=>{
      const [k,id] = String(btn.dataset.scadapull||"").split(":");
      const list2 = k==="datalogger" ? getDL() : getC();
      const dev = list2.find(x=>String(x.id)===String(id));
      if(!dev) return;
      await fetchScadaForDevice(k, dev);
      audit("SCADA_PULL", `${k}:${id}`);
    };
  });

  $("btnScadaFetchAll").onclick=async ()=>{
    await fetchScadaForAll(kind);
    audit("SCADA_PULL_ALL", kind);
  };
}

/* ---------- Boot app ---------- */


function ensureSeedSixMonths(){
  // Guaranteed local data (1 year) for: Meteorologia + DL/Caudalímetros.
  // Also updates each device current level/flow from latest point (map colors).
  try{
    const days = 365; // ~1 year
    const h = getHist();
    h.dl = h.dl || {};
    h.c  = h.c  || {};
    h.meteo = h.meteo || [];

    // Ensure meteo store exists
    const store = getMeteoHistStore();
    const metStore = (store && store.locs) ? store : { locs:{} };

    const ensureKey = (loc, lat, lng)=>{
      const locKey = (loc||"").trim();
      const key = locKey ? locKey : ((lat!=null && lng!=null) ? `@${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}` : "DEFAULT");
      if(!Array.isArray(metStore.locs[key]) || metStore.locs[key].length < 120){
        metStore.locs[key] = seedFallbackMeteoSeries(key, days);
      }
      return key;
    };

    const dls = getDL();
    const cs  = getC();

    // Guarantee meteo per device zone
    dls.forEach(d=>ensureKey(d.localidade||d.municipio||"", d.lat, d.lng));
    cs.forEach(c=>ensureKey(c.localidade||c.municipio||"", c.lat, c.lng));
    ensureKey("DEFAULT", 38.7223, -9.1393);

    try{ localStorage.setItem("adngest_meteo_hist_v1", JSON.stringify(metStore)); }catch(e){}

    // Ensure correlated histories and set current values on device objects
    const dlOut = dls.map(d=>{
      const id = String(d.id);
      const loc = (d.localidade||d.municipio||"").trim();
      const met = getMeteoSeriesForLoc(loc);
      if(!Array.isArray(h.dl[id]) || h.dl[id].length < 120){
        h.dl[id] = generateCorrelatedSeries(`dl:${id}:${loc}`, met, days)
          .map(p=>({ t:p.t, level_pct:p.level_pct, flow_lps:p.flow_lps, rain_mm:p.rain_mm }));
      }
      const last = h.dl[id][h.dl[id].length-1];
      if(last){
        d.level_pct = Number(last.level_pct);
        d.flow_lps  = Number(last.flow_lps);
      }
      return d;
    });

    const cOut = cs.map(c=>{
      const id = String(c.id);
      const loc = (c.localidade||c.municipio||"").trim();
      const met = getMeteoSeriesForLoc(loc);
      if(!Array.isArray(h.c[id]) || h.c[id].length < 120){
        h.c[id] = generateCorrelatedSeries(`c:${id}:${loc}`, met, days)
          .map(p=>({ t:p.t, level_pct:p.level_pct, flow_lps:p.flow_lps, rain_mm:p.rain_mm }));
      }
      const last = h.c[id][h.c[id].length-1];
      if(last){
        c.level_pct = Number(last.level_pct);
        c.flow_lps  = Number(last.flow_lps);
      }
      return c;
    });

    // Persist everything
    setDL(dlOut);
    setC(cOut);
    setHist(h);

    // Also expose meteo history into h.meteo in the format the UI expects (city + t + totals)
    // Keep it lightweight: last 180 days per first locality available
    try{
      const keys = Object.keys(metStore.locs||{});
      const k = keys[0] || "DEFAULT";
      const arr = metStore.locs[k] || [];
      const series = arr.slice(-days).map(p=>{
        const t = (typeof p.t==="number") ? p.t : Date.parse(p.t);
        return { city: k, t: new Date(t).toISOString(), p_total_mm: p.rain_mm ?? p.mm ?? 0, p_mm_h: null };
      });
      h.meteo = series;
      setHist(h);
    }catch(_e){}

    // Refresh visible screens
    try{ renderHistorico(); }catch(e){}
    try{ renderDashboard(); }catch(e){}
    try{ if(map) renderMapMarkers(); }catch(e){}
  }catch(e){}
}

async function preloadMeteoAndSeed(){
  try{
    // ensure meteo cached for each device zone
    const dls=getDL(); const cs=getC();
    for(const d of dls){
      const loc=(d.localidade||d.municipio||"").trim();
      await ensureMeteoForLoc(loc, d.lat, d.lng);
    }
    for(const c of cs){
      const loc=(c.localidade||c.municipio||"").trim();
      await ensureMeteoForLoc(loc, c.lat, c.lng);
    }
    // if no hist or too small, seed 6 months correlated
    const h=getHist();
    let need=false;
    try{
      const any = Object.values(h.dl||{}).some(arr=>Array.isArray(arr) && arr.length>=20) || Object.values(h.c||{}).some(arr=>Array.isArray(arr) && arr.length>=20);
      if(!any) need=true;
    }catch(e){ need=true; }
    if(need) seedDemoHistory(180);
  }catch(e){}
}

function bootApp(){
  try{ sbBootstrap(); }catch(e){}
  ensureSeedSixMonths();
  try{ updateMeteoHist1yForAllLocalities(); }catch(e){}

  try{
    if(!localStorage.getItem('__demoSeeded')){
      seedDemoHistory(30);
      seedDemoMeteo(30);
      localStorage.setItem('__demoSeeded','1');
    }
  }catch(e){}

  // nav
  qa(".navbtn").forEach(b=> b.onclick=()=> showTab(b.dataset.tab));
  $("btnGoDashboard").onclick=(e)=>{ e.preventDefault(); showTab("dashboard"); };

  $("btnLogout").onclick=doLogout;
  $("btnModalClose").onclick=closeModal;
  $("modal").addEventListener("click",(e)=>{ if(e.target?.id==="modal") closeModal(); });

  $("btnDoLogin").onclick=doLogin;
  $("loginEmail").addEventListener("keydown",(e)=>{ if(e.key==="Enter") doLogin(); });
  $("loginPass").addEventListener("keydown",(e)=>{ if(e.key==="Enter") doLogin(); });

  wireEyes();
  startClock();

  // Meteorologia: qualquer localidade em Portugal
  try{ populateCities(); }catch(e){}
  try{
    const b = $("btnWeatherSet");
    if(b) b.onclick = (e)=>{ e.preventDefault(); void applyWeatherLocationFromInput(); };
    const inp = $("weatherCity");
    if(inp) inp.addEventListener("keydown", (e)=>{ if(e.key==="Enter") { e.preventDefault(); void applyWeatherLocationFromInput(); } });
  }catch(e){}
  // Online presence heartbeat (local-only). Admins can see who is online.
  if(!window.__onlineHeartbeat){
    window.__onlineHeartbeat = setInterval(()=>{
      try{ markOnline(); }catch(e){}
      try{ renderOnlineUsers(); }catch(e){}
    }, 20000);
    window.addEventListener("beforeunload", ()=>{ try{ markOffline(); }catch(e){} });
  }
  recoverInit();
  alarmInit();
  // password eye toggles (single delegated handler)
  ensureEyeDelegate();
  ensureDashPickDelegate();
  applyAdminOnlyVisibility();
  ensureDashPickDelegate();
  applyAdminOnlyVisibility();


  // dashboard search filters
  $("qDL").addEventListener("input", renderQuickLists);
  $("qC").addEventListener("input", renderQuickLists);

  // Dashboard chart manual refresh (includes SCADA pull if configured)
  if($("btnDashRefresh")) $("btnDashRefresh").onclick=(e)=>{ 
  e.preventDefault(); 
  withBtnBusy($("btnDashRefresh"), async ()=>{
    try{
      // Always refresh dashboard view
      try{ renderDashboard(); }catch(_e){}
      const kind=_dashSel?.kind; const id=_dashSel?.id;
      if(kind && id){
        const list = kind==="datalogger" ? getDL() : getC();
        const dev = list.find(d=>String(d.id)===String(id));
        // Supabase pull (if configured)
        try{ if(sbEnabled() && id) await sbLoadTelemetryIntoHist(id, kind); }catch(e){}
        if(dev && dev.scada_url && String(dev.scada_url).trim()){
          await fetchScadaForDevice(kind, dev);
          audit("SCADA_PULL", `${kind}:${id}`);
        }
        __dashLastKey=""; __dashLastT="";
        renderDashboardDeviceChart(kind, id);
      }
    }catch(e){
      try{ renderDashboard(); }catch(_e){}
    }
  }); 
};
// tables
  const dlm=$("btnDLMap");
  if(dlm) dlm.onclick=()=>{ showTab("dashboard"); setTimeout(()=>{ map?.invalidateSize(true); }, 250); };
  const cm=$("btnCMap");
  if(cm) cm.onclick=()=>{ showTab("dashboard"); setTimeout(()=>{ map?.invalidateSize(true); }, 250); };

  // tables
  $("btnDLAdd").onclick=()=>addDevice("datalogger");
  $("btnCAdd").onclick=()=>addDevice("caudal");

  $("btnDLEdit").onclick=()=>{
    if(!canEditKind("datalogger")){ alert("Sem permissões."); return; }
    dlEditMode=!dlEditMode;
    audit("TOGGLE_EDIT", "dataloggers:"+dlEditMode);
    $("btnDLEdit").textContent = dlEditMode ? "Terminar edição" : "Editar";
    renderDLTable();
  };
  $("btnCEdit").onclick=()=>{
    if(!canEditKind("caudal")){ alert("Sem permissões."); return; }
    cEditMode=!cEditMode;
    audit("TOGGLE_EDIT", "caudal:"+cEditMode);
    $("btnCEdit").textContent = cEditMode ? "Terminar edição" : "Editar";
    renderCTable();
  };

  $("btnDLScada").onclick=()=>openScadaManager("datalogger");
  $("btnCScada").onclick=()=>openScadaManager("caudal");

  // admin-only SCADA
  if(!isAdmin()){
    const a=$("btnDLScada"); const b=$("btnCScada");
    if(a) a.style.display="none";
    if(b) b.style.display="none";
  }
  // admin-only SCADA

  // users
  $("btnUserAdd").onclick=addUser;

  // config
  $("btnAddMunicipio").onclick=addMunicipio;
  $("btnAddRio").onclick=addRio;
  $("btnCfgSave").onclick=saveConfig;
  if($("btnCfgTestAlert")) $("btnCfgTestAlert").onclick=testAlert;

  // historico
  $("histKind").onchange=()=>{ histDeviceOptions(false); renderHistorico(); };
  $("histDevice").onchange=renderHistorico;
  $("histAgg").onchange=renderHistorico;
  $("histRange").onchange=renderHistorico;
  $("btnHistRefresh").onclick=(e)=>{ e.preventDefault(); withBtnBusy($("btnHistRefresh"), async ()=>{ try{ await forceHistoricoRefresh(); }catch(_e){ try{ renderHistorico(); }catch(__e){} } }); };
  $("btnExportCSV").onclick=exportHistoricoCSV;
  $("btnExportPDF").onclick=exportPDF;
  if($("btnExportXLS")) $("btnExportXLS").onclick=exportHistoricoExcel;
  if($("histDate")) $("histDate").onchange=renderHistorico;
  $("btnHistDelete").onclick=deleteHistorico;
  if($("btnHistDeleteScope")) $("btnHistDeleteScope").onclick=deleteHistoricoScoped;

  // audit
  $("btnAuditExport").onclick=exportAuditCSV;
  $("btnAuditClear").onclick=clearAudit;

  // init map + data
  ensureBootstrap();
  ensureSeedSixMonths();
  refreshHeader();
  try{ applyNavPerms(); }catch(e){}

  // Leaflet requires a visible container with a non-zero size.
  // Make Dashboard visible before initializing the map.
  showTab("dashboard");
  initMap();
  // First paint after init
  try{ map?.invalidateSize(true); }catch(e){}
  renderDashboard();
  renderDLTable();
  renderCTable();
  renderUsers();
  renderConfig();
  renderAudit();
  histDeviceOptions(false);
  renderHistorico();

  // Ferramentas (v66)
  try{ initFerramentas(); }catch(e){}

  // initial weather
  loadWeather().catch(()=>{
    $("weatherMeta").textContent = "Sem ligação ao servidor meteorológico.";
  });

  // keep meteorology history up-to-date for all localities (rain mm)
  updateMeteoForAllLocalities();
  // keep 1-year daily archive (precipitation_sum) stored locally for Historico/Simulation
  try{ void updateMeteoHist1yForAllLocalities(); }catch(e){}
  try{ startMeteoAllAutoUpdate(); }catch(e){}
  // SCADA polling (optional) — if links are configured
  try{ startScadaAutoUpdate(); }catch(e){}
  // start simulated history recording each minute
  if(simTimer) clearInterval(simTimer);
  simTimer = setInterval(tickSimulateHistory, 60_000);

  // also seed one tick now so history isn't empty
  tickSimulateHistory();

  // default tab already set above (kept visible for Leaflet sizing)

  // auto-refresh charts (dashboard/historico) and make them resilient to hidden-tab layout.
  try{ startChartsAutoRefresh(); }catch(e){}
  // Histórico de Dados: refresh periódico (10 em 10 minutos) + botão Atualizar
  try{ startHistoricoAutoRefresh(); }catch(e){}
}

/* ---------- Start ---------- */
window.addEventListener("DOMContentLoaded", ()=>{
  ensureBootstrap();
  ensureSeedSixMonths();
  // restore session if exists
  const sess = load(LS.session, {email:null});
  const logged = !!sess.email;
  setAuthUI(logged);
  refreshHeader();
  try{ applyNavPerms(); }catch(e){}
  wireEyes();
  ensureEyeDelegate();
  ensureDashPickDelegate();
  applyAdminOnlyVisibility();
  ensureDashPickDelegate();
  applyAdminOnlyVisibility();
  $("btnDoLogin").onclick=doLogin;
  $("btnLogout").onclick=doLogout;
  if(logged){
    bootApp();
  }

  // Keep charts stable across resizes (prevents "disappearing" canvas due to 0px width).
  let _rzT=null;
  window.addEventListener("resize", ()=>{
    if(_rzT) clearTimeout(_rzT);
    _rzT = setTimeout(()=>{ try{ redrawVisibleCharts(); }catch(e){} }, 120);
  });
});

// v47 recover password + alarms
function openDialog(id){ const d=$(id); if(d && d.showModal) d.showModal(); }
function closeDialog(id){ const d=$(id); if(d && d.close) d.close(); }

function genCode6(){ return String(Math.floor(100000 + Math.random()*900000)); }

function recoverInit(){
  const b=$("btnForgot"); if(b) b.onclick=()=>{ $("recMsg").textContent=""; $("recStep2").style.display="none"; openDialog("dlgRecover"); };
  const c=$("btnCloseRecover"); if(c) c.onclick=()=>closeDialog("dlgRecover");
  const send=$("btnSendRecover"); if(send) send.onclick=()=>{
    const email=($("recEmail").value||"").trim().toLowerCase();
    const users=load(LS.users,[]);
    const u=users.find(x=>(x.email||"").toLowerCase()===email);
    if(!email){ $("recMsg").textContent="Indica um email."; return; }
    if(!u){ $("recMsg").textContent="Email não encontrado."; return; }
    const code=genCode6();
    save("ADNGEST_RECOVER_"+email, { code, exp: Date.now()+15*60*1000 }); // 15 min
    $("recCode").textContent=code;
    $("recStep2").style.display="block";
    $("recMsg").textContent="Código gerado. (Envio por email simulado)";
  };
  const apply=$("btnApplyRecover"); if(apply) apply.onclick=()=>{
    const email=($("recEmail").value||"").trim().toLowerCase();
    const store=load("ADNGEST_RECOVER_"+email, null);
    const codeIn=($("recCodeIn").value||"").trim();
    const np=($("recNewPass").value||"").trim();
    if(!store || !store.code){ $("recMsg").textContent="Gera um código primeiro."; return; }
    if(Date.now()>store.exp){ $("recMsg").textContent="Código expirado. Gera outro."; return; }
    if(codeIn!==store.code){ $("recMsg").textContent="Código incorreto."; return; }
    if(np.length<4){ $("recMsg").textContent="Password demasiado curta."; return; }
    const users=load(LS.users,[]);
    const u=users.find(x=>(x.email||"").toLowerCase()===email);
    if(!u){ $("recMsg").textContent="Email não encontrado."; return; }
    u.pass=np;
    save(LS.users, users);
    save("ADNGEST_RECOVER_"+email, null);
    $("recMsg").textContent="Password alterada com sucesso.";
  };
}

function alarmInit(){
  const c=$("btnCloseAlarm"); if(c) c.onclick=()=>closeDialog("dlgAlarm");
}
function showAlarm(title, bodyHtml){
  const t=$("alarmTitle"); const b=$("alarmBody");
  if(t) t.textContent=title;
  if(b) b.innerHTML=bodyHtml;
  openDialog("dlgAlarm");
}

const ALARM_KEY="ADNGEST_ALARMS";
function getAlarmState(){ return load(ALARM_KEY, {}); }
function setAlarmState(s){ save(ALARM_KEY, s); }

function checkBatteryAlarms(){
  const dls=load(LS.dl,[]);
  const state=getAlarmState();
  for(const d of dls){
    const days = Number(d.battery_days??d.battery_days_left??d.batt_days??0);
    if(!Number.isFinite(days)) continue;
    const id="DL_"+d.id;
    const sent = state[id]||{};
    const thresholds=[30,15,7,0];
    for(const th of thresholds){
      const key="batt_"+th;
      if(days<=th && !sent[key]){
        sent[key]=Date.now();
        state[id]=sent;
        const name=escapeHtml(d.name||("Data Logger "+d.id));
        const msg = th==0 ? "Bateria esgotada." : `Faltam ${th} dias para a bateria terminar.`;
        showAlarm("Alarme de Bateria", `<div class="pill">Equipamento: <b>${name}</b></div><div style="margin-top:10px">${msg}</div>`);
      }
    }
  }
  setAlarmState(state);
}

function checkCommAlarms(){
  const now=Date.now();
  const state=getAlarmState();
  const maxMs = 60*60*1000; // 60 min
  const checkList = [
    {kind:"DL", key:LS.dl, name:"Data Logger"},
    {kind:"C",  key:LS.c,  name:"Caudalímetro"}
  ];
  for(const item of checkList){
    const list=load(item.key,[]);
    for(const d of list){
      const last = Number(d.last_comm_ts||0);
      if(last<=0) continue; // if not available, skip
      if(now-last > maxMs){
        const id=item.kind+"_"+d.id;
        const sent=state[id]||{};
        if(!sent.comm){
          sent.comm=Date.now();
          state[id]=sent;
          const name=escapeHtml(d.name||(`${item.name} ${d.id}`));
          showAlarm("Alarme de Comunicação", `<div class="pill">Equipamento: <b>${name}</b></div><div style="margin-top:10px">Sem comunicação há mais de 60 minutos.</div>`);
        }
      }
    }
  }
  setAlarmState(state);
}

// v50 per-device mini chart + stats
function renderDeviceMini(kind, id){
  const c = $("devMiniChart");
  if(!c || !c.getContext) return;
  const ctx = c.getContext("2d");
  const h = getHist();
  const key = kind==="datalogger" ? "dl" : "c";
  const arr = (h[key] && h[key][id]) ? h[key][id] : [];
  const pts = arr.slice(-240); // last 4h at 1-min
  const levels = pts.map(p=>Number(p.level_pct||0));
  const flows  = pts.map(p=>Number(p.flow_lps||0));
  const w = c.width = c.clientWidth * (window.devicePixelRatio||1);
  const hh = c.height = 140 * (window.devicePixelRatio||1);
  ctx.clearRect(0,0,w,hh);
  // axes padding
  const padL=34*(window.devicePixelRatio||1), padR=10*(window.devicePixelRatio||1), padT=10*(window.devicePixelRatio||1), padB=24*(window.devicePixelRatio||1);
  const iw = w-padL-padR, ih = hh-padT-padB;
  const maxFlow = Math.max(1, ...flows);
  const minFlow = Math.min(...flows);
  const maxLvl = 100, minLvl=0;
  // background grid
  ctx.globalAlpha=0.18;
  ctx.beginPath();
  for(let i=0;i<=4;i++){
    const y = padT + ih*(i/4);
    ctx.moveTo(padL,y); ctx.lineTo(padL+iw,y);
  }
  ctx.stroke();
  ctx.globalAlpha=1;
  // helper to map
  const xAt = (i)=> padL + (pts.length<=1?0:(iw*(i/(pts.length-1))));
  const yLvl = (v)=> padT + ih*(1 - ((v-minLvl)/(maxLvl-minLvl)));
  const yFlow = (v)=> {
    const denom = (maxFlow - minFlow) || 1;
    return padT + ih*(1 - ((v-minFlow)/denom));
  };
  // level line
  ctx.beginPath();
  levels.forEach((v,i)=>{ const x=xAt(i), y=yLvl(v); if(i==0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
  ctx.stroke();
  // flow line (dashed)
  ctx.setLineDash([6*(window.devicePixelRatio||1),4*(window.devicePixelRatio||1)]);
  ctx.beginPath();
  flows.forEach((v,i)=>{ const x=xAt(i), y=yFlow(v); if(i==0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
  ctx.stroke();
  ctx.setLineDash([]);
  // labels
  ctx.globalAlpha=0.85;
  ctx.fillText("Nível", 6*(window.devicePixelRatio||1), 14*(window.devicePixelRatio||1));
  ctx.fillText("Caudal", 6*(window.devicePixelRatio||1), 30*(window.devicePixelRatio||1));
  ctx.globalAlpha=1;
  // stats
  const lvlNow = levels.length? levels[levels.length-1] : null;
  const flowNow = flows.length? flows[flows.length-1] : null;
  const lvlMin = levels.length? Math.min(...levels):null;
  const lvlMax = levels.length? Math.max(...levels):null;
  const flowMin = flows.length? Math.min(...flows):null;
  const flowMax = flows.length? Math.max(...flows):null;
  if($("statLvlNow")) $("statLvlNow").textContent = (lvlNow===null?"—":String(lvlNow));
  if($("statLvlMin")) $("statLvlMin").textContent = (lvlMin===null?"—":String(lvlMin));
  if($("statLvlMax")) $("statLvlMax").textContent = (lvlMax===null?"—":String(lvlMax));
  if($("statFlowNow")) $("statFlowNow").textContent = (flowNow===null?"—":String(flowNow));
  if($("statFlowMin")) $("statFlowMin").textContent = (flowMin===null?"—":String(flowMin));
  if($("statFlowMax")) $("statFlowMax").textContent = (flowMax===null?"—":String(flowMax));
}

/* ---------- Charts (linha + barras) ---------- */
function _scale(v, min, max){
  if(max===min) return 0.5;
  return (v-min)/(max-min);
}
function drawCombo(canvas, series, opts){
  if(!canvas) return;
  // If the canvas is in a hidden tab/container, width may be 0 and the chart will look "missing".
  // Defer drawing until layout is measurable.
  if(!_ensureCanvasRenderable(canvas, ()=>drawCombo(canvas, series, opts))) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  if(!canvas.dataset.baseH){ canvas.dataset.baseH = canvas.getAttribute("height") || "180"; }
  const baseH = Number(canvas.dataset.baseH) || 180;
  const parentW = (canvas.parentElement?.clientWidth||600);
  const w = canvas.width = Math.max(320, parentW-4) * dpr;
  const h = canvas.height = (Number(canvas.getAttribute("height"))||180) * dpr;
  canvas.style.width = "100%";
  canvas.style.height = (Number(canvas.getAttribute("height"))||180) + "px";
  ctx.clearRect(0,0,w,h);
  // card background (matches Histórico styling)
  ctx.fillStyle = 'rgba(255,255,255,.94)';
  ctx.fillRect(0,0,w,h);
  ctx.strokeStyle = 'rgba(2,6,23,.10)';
  ctx.lineWidth = 1*dpr;
  ctx.strokeRect(0.5*dpr,0.5*dpr,w-1*dpr,h-1*dpr);


  // Title (optional)
  if(opts && opts.title){
    ctx.fillStyle = 'rgba(2,6,23,.86)';
    ctx.font = `${14*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
    const t = String(opts.title);
    const tw = ctx.measureText(t).width;
    ctx.fillText(t, Math.max(12*dpr, (w - tw)/2), 18*dpr);
  }

  // Larger axis label area for readability (requested: big numbers)
  const padL = 66*dpr, padR = 66*dpr, padT = 24*dpr, padB = 38*dpr;
  const iw = w-padL-padR, ih = h-padT-padB;

  const bars = (series||[]).map(s=> Number(s[opts.barKey]??0));
  const line = (series||[]).map(s=> Number(s[opts.lineKey]??0));

  const bMin = Math.min(...bars), bMax = Math.max(...bars);
  const lMin = Math.min(...line), lMax = Math.max(...line);

  const xAt = (i)=> padL + (series.length<=1?0: iw*(i/(series.length-1)));
  const scale = (v,min,max)=> (max===min)?0.5:((v-min)/(max-min));
  const yBar = (v)=> padT + ih*(1-scale(v,bMin,bMax));
  const yLine= (v)=> padT + ih*(1-scale(v,lMin,lMax));

  // grid + axes
  ctx.strokeStyle="rgba(2,6,23,.16)";
  ctx.lineWidth=1*dpr;
  ctx.beginPath();
  for(let i=0;i<=4;i++){
    const y = padT + ih*(i/4);
    ctx.moveTo(padL,y); ctx.lineTo(padL+iw,y);
  }
  // left axis line
  ctx.moveTo(padL,padT); ctx.lineTo(padL,padT+ih);
  // right axis line
  ctx.moveTo(padL+iw,padT); ctx.lineTo(padL+iw,padT+ih);
  ctx.stroke();

  // tick labels
  ctx.fillStyle="rgba(2,6,23,.80)";
  ctx.font = `${16*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;

  // left (line) scale
  for(let i=0;i<=4;i++){
    const v = lMax - (lMax-lMin)*(i/4);
    const y = padT + ih*(i/4);
    const txt = isFinite(v) ? v.toFixed(opts.lineDecimals??1) : "—";
    ctx.fillText(txt, 6*dpr, y+4*dpr);
  }
  // right (bar) scale
  for(let i=0;i<=4;i++){
    const v = bMax - (bMax-bMin)*(i/4);
    const y = padT + ih*(i/4);
    const txt = isFinite(v) ? v.toFixed(opts.barDecimals??2) : "—";
    const tw = ctx.measureText(txt).width;
    ctx.fillText(txt, w - tw - 6*dpr, y+4*dpr);
  }

  // bars (rounded)
  ctx.fillStyle = opts.barColor || "rgba(37,99,235,.22)";
  const bw = iw/Math.max(1,series.length)*0.85;
  const r = 4*dpr;
  for(let i=0;i<series.length;i++){
    const x = xAt(i)-bw/2;
    const y = yBar(bars[i]);
    const hh = (padT+ih)-y;
    // rounded rectangle
    ctx.beginPath();
    const rr = Math.min(r, bw/2, hh/2);
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+bw, y, x+bw, y+hh, rr);
    ctx.arcTo(x+bw, y+hh, x, y+hh, rr);
    ctx.arcTo(x, y+hh, x, y, rr);
    ctx.arcTo(x, y, x+bw, y, rr);
    ctx.closePath();
    ctx.fill();
  }

  // line
  ctx.strokeStyle = opts.lineColor || "rgba(212,175,55,.95)";
  ctx.lineWidth = 2*dpr;
  ctx.beginPath();
  for(let i=0;i<series.length;i++){
    const x=xAt(i), y=yLine(line[i]);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // line points
  ctx.fillStyle = opts.lineColor || "rgba(212,175,55,.95)";
  for(let i=0;i<series.length;i++){
    const x=xAt(i), y=yLine(line[i]);
    ctx.beginPath();
    ctx.arc(x, y, 2.2*dpr, 0, Math.PI*2);
    ctx.fill();
  }

  // x-axis ticks (time labels) - keep few labels for clarity
  try{
    const labels = (series||[]).map(s=>String(s.t||""));
    const n = labels.length;
    if(n>1){
      ctx.fillStyle = "rgba(2,6,23,.70)";
      ctx.font = `${12*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
      const idxs = [];
      idxs.push(0);
      if(n>6) idxs.push(Math.floor(n/2));
      idxs.push(n-1);
      const uniq = Array.from(new Set(idxs)).filter(i=>i>=0 && i<n);
      uniq.forEach(i=>{
        const raw = labels[i];
        const txt = raw.length>16 ? raw.slice(11,16) : raw; // show HH:MM if full timestamp
        const x = xAt(i);
        const y = padT + ih + 26*dpr;
        const tw = ctx.measureText(txt).width;
        ctx.fillText(txt, Math.max(padL, Math.min(padL+iw-tw, x - tw/2)), y);
      });
    }
  }catch(e){}

  // legend
  // Legend with color keys (requested: legends in all charts)
  const lgFont = 13*dpr;
  ctx.font = `${lgFont}px system-ui, -apple-system, Segoe UI, Roboto`;
  const lx = Math.max(padL, padL + iw - 190*dpr);
  const ly1 = 44*dpr;
  const ly2 = 62*dpr;
  const sw = 10*dpr, sh = 10*dpr, gap = 6*dpr;
  // line key
  if(opts.lineLabel){
    ctx.fillStyle = opts.lineColor || "rgba(212,175,55,.95)";
    ctx.fillRect(lx, ly1 - sh + 2*dpr, sw, sh);
    ctx.fillStyle = "rgba(2,6,23,.82)";
    ctx.fillText(String(opts.lineLabel), lx + sw + gap, ly1);
  }
  // bar key
  if(opts.barLabel){
    ctx.fillStyle = opts.barColor || "rgba(37,99,235,.22)";
    ctx.fillRect(lx, ly2 - sh + 2*dpr, sw, sh);
    ctx.fillStyle = "rgba(2,6,23,.82)";
    ctx.fillText(String(opts.barLabel), lx + sw + gap, ly2);
  }
}

// Override historical chart to use combo
function drawChart(series){
  const kind = $("histKind").value;
  // auto select first available device so table is not empty
  try{
    const sel=$("histDevice");
    if(sel && (!sel.value || sel.selectedIndex<0)){
      if(sel.options.length>0){ sel.selectedIndex=0; }
    }
  }catch(e){}
  const canvas = $("histChart");
  if(!series || series.length<1){
    const ctx=canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w=canvas.width = Math.max(320, (canvas.parentElement?.clientWidth||600)-4) * dpr;
    const h = (Number(canvas.getAttribute("height"))||180) * dpr;
    canvas.height = h;
    canvas.style.width = "100%";
    canvas.style.height = (Number(canvas.getAttribute("height"))||180) + "px";
    ctx.clearRect(0,0,w,canvas.height);
    ctx.fillStyle="rgba(2,6,23,.70)";
    ctx.font = `${12*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText("Sem dados suficientes para gráfico.", 12*dpr, 24*dpr);
    return;
  }
  // For meteo: bars precipitation, line precipitation too (scaled)
  const opts = kind==="meteo"
    ? { barKey:"p_mm_h", lineKey:"p_mm_h", barLabel:"Precipitação (mm/h)", lineLabel:"Precipitação (mm/h)" }
    : { barKey:"flow_lps", lineKey:"level_pct", barLabel:"Caudal (m³)", lineLabel:"Nível (%)" };
  drawCombo(canvas, series, opts);
}

function getDeviceSeries(kind, id){
  const k = (kind||"").toLowerCase();
  const isDL = (k==="datalogger" || k==="dl" || k==="logger" || k==="data_logger");
  const h = getHist();
  const key = isDL ? "dl" : "c";
  let arr = (h[key] && h[key][id]) ? h[key][id] : [];

  if(!arr || !arr.length){
    try{
      const k2 = "hist_" + (isDL ? "datalogger" : "caudal") + "_" + id;
      const a2 = JSON.parse(localStorage.getItem(k2) || "[]");
      if(Array.isArray(a2) && a2.length) arr = a2;
    }catch(e){}
  }

  
  // Demo fallback if still empty
  try{
    if(!arr || !arr.length){
      arr = generateDemoSeries(String(kind)+":"+String(id), 30);
      // also persist into consolidated history for consistency
      try{
        const hh = getHist();
        const kk = (String(kind).toLowerCase()==="datalogger") ? "dl" : "c";
        hh[kk] = hh[kk] || {};
        hh[kk][id] = arr.map(p=>({t:p.t, level_pct:p.level_pct, flow_lps:p.flow_lps}));
        save(LS.hist, hh);
      }catch(_e){}
    }
  }catch(e){}
return (arr||[]).map(p=>{
    const rawT = p.t ?? p.ts ?? p.timestamp ?? p.time ?? p.date ?? p.datetime;
    const ms = (typeof rawT==="number") ? rawT : Date.parse(rawT);
    return {
      t: (Number.isFinite(ms) ? ms : null),
      level_pct: p.level_pct ?? p.nivel_pct ?? p.nivel ?? p.lvl ?? p.level,
      flow_lps: p.flow_lps ?? p.flow_m3 ?? p.caudal_m3 ?? p.caudal ?? p.q ?? p.flow
    };
  }).filter(p=>p.t!=null).slice(-180);
}




function renderDeviceChart(kind, id){
  const series = getDeviceSeries(kind, id);
  const canvas = $("devChart");
  if(!canvas) return;
  if(series.length<2){
    if(sbEnsureTelemetry(kind, id, ()=>renderHistorico())){ return; }

    const ctx=canvas.getContext("2d");
    const w=canvas.width = canvas.parentElement.clientWidth - 4;
    ctx.clearRect(0,0,w,canvas.height);
    ctx.fillText("Sem dados suficientes.", 12, 24);
    return;
  }
  const st = drawDashChart(series, kind, title);
  const lvlMin = Math.min(...series.map(s=>Number(s.level_pct||0)));
  const lvlMax = Math.max(...series.map(s=>Number(s.level_pct||0)));
  const flMin = Math.min(...series.map(s=>Number(s.flow_lps||0)));
  const flMax = Math.max(...series.map(s=>Number(s.flow_lps||0)));
  if($("devLvlMin")) $("devLvlMin").textContent = isFinite(lvlMin)? lvlMin.toFixed(1):"—";
  if($("devLvlMax")) $("devLvlMax").textContent = isFinite(lvlMax)? lvlMax.toFixed(1):"—";
  if($("devFlowMin")) $("devFlowMin").textContent = isFinite(flMin)? flMin.toFixed(2):"—";
  if($("devFlowMax")) $("devFlowMax").textContent = isFinite(flMax)? flMax.toFixed(2):"—";
}

let _dashSel = { kind:null, id:null, name:null };
function selectDashboardDevice(kind, id, name){
  const k=(kind||"").toLowerCase();
  const isDL = (k==="datalogger" || k==="dl" || k==="logger");
  const normKind = isDL ? "datalogger" : "caudal";
  _dashSel = { kind: normKind, id, name };

  // force immediate refresh even if the last auto-tick key matches
  __dashLastKey = "";
  __dashLastT = "";

  if($("dashSelLabel")) $("dashSelLabel").textContent = name ? name : "—";

  // redraw chart/table immediately
  try{ renderDashboardDeviceChart(normKind, id); }catch(e){}
  try{ renderDashboard(); }catch(e){}

  // If SCADA link exists, pull latest on selection (best-effort) then redraw
  try{
    (async ()=>{
      const list = normKind==="datalogger" ? getDL() : getC();
      const dev = list.find(d=>String(d.id)===String(id));
      if(dev && dev.scada_url && String(dev.scada_url).trim()){
        await fetchScadaForDevice(normKind, dev);
        audit("SCADA_PULL", `${normKind}:${id}`);
        __dashLastKey=""; __dashLastT="";
        renderDashboardDeviceChart(normKind, id);
      }
    })();
  }catch(e){}
}
function renderDashSeriesTable(series){
  const tbl = $("tblDashSeries");
  if(!tbl) return;
  const tbody = tbl.querySelector('tbody');
  if(!series || !series.length){
    tbody.innerHTML = `<tr><td colspan="3" class="muted small">Sem dados.</td></tr>`;
    return;
  }
  const rows = series.slice().reverse().slice(0,20).map(p=>{
    const t = escapeHtml(String(p.t));
    const lvl = (p.level_pct===null||p.level_pct===undefined)?'—':escapeHtml(String(p.level_pct));
    const flw = (p.flow_lps===null||p.flow_lps===undefined)?'—':escapeHtml(String(p.flow_lps));
    return `<tr><td>${t}</td><td>${lvl}</td><td>${flw}</td></tr>`;
  }).join('');
  tbody.innerHTML = rows || `<tr><td colspan="3" class="muted small">Sem dados.</td></tr>`;
}

function renderDashboardDeviceChart(kind, id){
  if((kind===undefined || id===undefined) && typeof _dashSel==="object" && _dashSel){ kind=_dashSel.kind; id=_dashSel.id; }

  const canvas=$("dashChart");
  if(!canvas) return;
  if(!_ensureCanvasRenderable(canvas, ()=>renderDashboardDeviceChart(kind, id))) return;
  const dpr=window.devicePixelRatio||1;
  if(!canvas.dataset.baseH){ canvas.dataset.baseH = canvas.getAttribute("height") || "170"; }
  const baseH = Number(canvas.dataset.baseH) || 170;
  const parentW = canvas.parentElement ? canvas.parentElement.clientWidth : 600;
  canvas.width = Math.max(320, parentW-4) * dpr;
  canvas.height = baseH * dpr;
  canvas.style.width = "100%";
  canvas.style.height = baseH + "px";

  const series = getDeviceSeries(kind, id).slice(-180);
  // tabela (últimos registos)
  renderDashSeriesTable(series);
  if(series.length < 2){
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle="rgba(2,6,23,.70)";
    ctx.font = `${12*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText("Sem dados suficientes.", 12*dpr, 24*dpr);
    return;
  }
  // Title: selected device name (if known)
  let title = "";
drawDashChart(series, kind, title);

  // update min/max table
  try{
    const lvls = series.map(s=>Number(s.level_pct)).filter(v=>Number.isFinite(v));
    const flows = series.map(s=>Number(s.flow_lps)).filter(v=>Number.isFinite(v));
    const lvlMin = lvls.length? Math.min(...lvls): null;
    const lvlMax = lvls.length? Math.max(...lvls): null;
    const flowMin = flows.length? Math.min(...flows): null;
    const flowMax = flows.length? Math.max(...flows): null;
    if($("dashLvlMin")) $("dashLvlMin").textContent = (lvlMin===null? "—": lvlMin.toFixed(1));
    if($("dashLvlMax")) $("dashLvlMax").textContent = (lvlMax===null? "—": lvlMax.toFixed(1));
    if($("dashFlowMin")) $("dashFlowMin").textContent = (flowMin===null? "—": flowMin.toFixed(2));
    if($("dashFlowMax")) $("dashFlowMax").textContent = (flowMax===null? "—": flowMax.toFixed(2));
  }catch(e){}

  const lvlMin = Math.min(...series.map(s=>Number(s.level_pct||0)));
  const lvlMax = Math.max(...series.map(s=>Number(s.level_pct||0)));
  const flMin  = Math.min(...series.map(s=>Number(s.flow_lps||0)));
  const flMax  = Math.max(...series.map(s=>Number(s.flow_lps||0)));
}

/* ---------- v53 Hidrogramas ---------- */
function initSubtabs(){
  qa(".subtabs").forEach(box=>{
    const kind = box.getAttribute("data-kind");
    const section = box.closest("section");
    const panelId = kind==="dl" ? "dl-hidroPanel" : "c-hidroPanel";
    const listPanel = $(panelId);
    const tablewrap = section ? section.querySelector(".tablewrap") : null;
    box.querySelectorAll(".subtab").forEach(btn=>{
      btn.onclick=()=>{
        box.querySelectorAll(".subtab").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active");
        const sub = btn.getAttribute("data-sub");
        if(sub==="hidro"){
          if(tablewrap) tablewrap.classList.add("hidden");
          if(listPanel) listPanel.classList.remove("hidden");
          renderHidrogramas(kind);
        } else {
          if(listPanel) listPanel.classList.add("hidden");
          if(tablewrap) tablewrap.classList.remove("hidden");
        }
      };
    });
  });
}

function drawHydroCurve(canvas, series, opts){
  if(!canvas) return;
  const ctx=canvas.getContext("2d");
  const dpr=window.devicePixelRatio||1;
  const parentW = canvas.parentElement ? canvas.parentElement.clientWidth : 600;
  const w = canvas.width = Math.max(320, parentW-4)*dpr;
  const h = canvas.height = (Number(canvas.getAttribute("height"))||120)*dpr;
  ctx.clearRect(0,0,w,h);

  const padL=52*dpr, padR=12*dpr, padT=10*dpr, padB=22*dpr;
  const iw=w-padL-padR, ih=h-padT-padB;

  const vals = (series||[]).map(p=>Number(p.val??0));
  const vMin=Math.min(...vals), vMax=Math.max(...vals);
  const scale=(v)=> (vMax===vMin)?0.5:((v-vMin)/(vMax-vMin));
  const xAt=(i)=> padL + (series.length<=1?0: iw*(i/(series.length-1)));
  const yAt=(v)=> padT + ih*(1-scale(v));

  // grid + axis
  ctx.strokeStyle="rgba(2,6,23,.16)";
  ctx.lineWidth=1*dpr;
  ctx.beginPath();
  for(let i=0;i<=4;i++){
    const y=padT + ih*(i/4);
    ctx.moveTo(padL,y); ctx.lineTo(padL+iw,y);
  }
  ctx.moveTo(padL,padT); ctx.lineTo(padL,padT+ih);
  ctx.stroke();

  // y labels
  ctx.fillStyle="rgba(2,6,23,.80)";
  ctx.font = `${14*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
  for(let i=0;i<=4;i++){
    const v=vMax - (vMax-vMin)*(i/4);
    const y=padT + ih*(i/4);
    const txt=isFinite(v)? v.toFixed(opts.decimals??2):"—";
    ctx.fillText(txt, 6*dpr, y+4*dpr);
  }

  if(!series || series.length<1){
    ctx.fillStyle="rgba(2,6,23,.70)";
    ctx.fillText("Sem dados suficientes.", padL, padT+16*dpr);
    return;
  }

  // legend (color key)
  try{
    const sw = 10*dpr, sh = 10*dpr, gap = 6*dpr;
    ctx.font = `${12*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillStyle = opts.color||"rgba(37,99,235,.95)";
    ctx.fillRect(padL, 10*dpr, sw, sh);
    ctx.fillStyle = "rgba(2,6,23,.82)";
    ctx.fillText(String(opts.label||"Série"), padL + sw + gap, 20*dpr);
  }catch(e){}

  // smooth curve (Catmull-Rom -> Bezier)
  ctx.strokeStyle=opts.color||"rgba(37,99,235,.95)";
  ctx.lineWidth=2*dpr;
  ctx.beginPath();
  for(let i=0;i<series.length;i++){
    const p0 = series[Math.max(0,i-1)];
    const p1 = series[i];
    const p2 = series[Math.min(series.length-1,i+1)];
    const p3 = series[Math.min(series.length-1,i+2)];

    const x1=xAt(i), y1=yAt(p1.val);
    if(i===0){ ctx.moveTo(x1,y1); continue; }

    const x0=xAt(Math.max(0,i-1)), y0=yAt(p0.val);
    const x2=xAt(Math.min(series.length-1,i+1)), y2=yAt(p2.val);
    const x3=xAt(Math.min(series.length-1,i+2)), y3=yAt(p3.val);

    const tension=0.5;
    const cp1x = x0 + (x2 - x0)*tension/6;
    const cp1y = y0 + (y2 - y0)*tension/6;
    const cp2x = x1 - (x3 - x1)*tension/6;
    const cp2y = y1 - (y3 - y1)*tension/6;

    ctx.bezierCurveTo(cp1x,cp1y,cp2x,cp2y,x1,y1);
  }
  ctx.stroke();

  // legend
  const sw = 10*dpr, sh = 10*dpr;
  ctx.fillStyle = opts.color||"rgba(37,99,235,.95)";
  ctx.fillRect(padL, 6*dpr, sw, sh);
  ctx.fillStyle = "rgba(2,6,23,.82)";
  ctx.font = `${13*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
  ctx.fillText(opts.label||"", padL + sw + 6*dpr, 14*dpr);
}

function renderHidrogramas(kind){
  const listEl = $(kind==="dl" ? "dl-hidroList" : "c-hidroList");
  if(!listEl) return;
  const devices = kind==="dl" ? getDL() : getC();

  listEl.innerHTML = devices.map(d=>{
    const id=String(d.id);
    const nowFlow = (d.flow_lps??"—");
    const nowLvl = (d.level_pct??"—");
    return `
      <div class="hidro-item" data-hid="${escapeHtml(id)}">
        <div class="hidro-item-head">
          <div>
            <div class="hidro-item-title">${escapeHtml(d.name||"—")}</div>
            <div class="muted small">${escapeHtml(d.municipio||"")} • ${escapeHtml(d.rio||"")}</div>
          </div>
          <div class="hidro-item-meta">
            <div class="hydro-kpi">Nível: <b>${escapeHtml(String(nowLvl))}%</b></div>
            <div class="hydro-kpi">Caudal: <b>${escapeHtml(String(nowFlow))} m³</b></div>
          </div>
        </div>
        <canvas class="hidro-canvas" id="${kind}-hidro-${escapeHtml(id)}" height="120"></canvas>
      </div>`;
  }).join("") || `<div class="muted">Sem equipamentos.</div>`;

  devices.forEach(d=>{
    const id=String(d.id);
    const canvas=$( `${kind}-hidro-${id}` );
    // Use device history if present; fallback to last simulated points by generating from current values.
    let series = getDeviceSeries(kind==="dl"?"datalogger":"caudal", id).slice(-120).map(p=>({val:Number(p.flow_lps??0)}));
    if(!series || series.length<1){
      const base=Number(d.flow_lps??0);
      series = Array.from({length:48},(_,i)=>({val: Math.max(0, base + (Math.sin(i/6)*0.6) )}));
    }
    drawHydroCurve(canvas, series, { label:"Hidrograma (Caudal m³)", decimals:2, color:"rgba(37,99,235,.95)" });
  });
}

/* ---------- v55 Hidrogramas ---------- */
function showHidrogramas(kind, show){
  const panel = $(kind==="dl" ? "dl-hidroPanel" : "c-hidroPanel");
  const tablewrap = (kind==="dl" ? $("tab-dataloggers") : $("tab-caudalimetros"))?.querySelector(".tablewrap");
  const tbl = (kind==="dl") ? q("#tblDL") : q("#tblC");
  if(show){
    if(tablewrap) tablewrap.classList.add("hidden");
    if(tbl) tbl.classList.add("hidden");
    if(panel){ panel.classList.remove("hidden"); panel.style.display="block"; }
    renderHidrogramas(kind);
  } else {
    if(panel){ panel.classList.add("hidden"); panel.style.display="none"; }
    if(tablewrap) tablewrap.classList.remove("hidden");
    if(tbl) tbl.classList.remove("hidden");
  }
}

function getDeviceSeriesShort(kind, id){
  const h=getHist();
  const key = kind==="dl" ? "dl" : "c";
  const arr = (h[key] && h[key][id]) ? h[key][id] : [];
  return arr.slice(-180);
}

function renderHidrogramas(kind){
  const listEl = $(kind==="dl" ? "dl-hidroList" : "c-hidroList");
  if(!listEl) return;
  const devices = kind==="dl" ? getDL() : getC();
  listEl.innerHTML = devices.map(d=>{
    const id=String(d.id);
    return `<div class="hidro-item">
      <div class="hidro-item-head">
        <div>
          <div class="hidro-item-title">${escapeHtml(d.name||"—")}</div>
          <div class="muted small">${escapeHtml(d.municipio||"")} • ${escapeHtml(d.rio||"")}</div>
        </div>
        <div class="hidro-item-meta">
          <div class="hydro-kpi">Nível: <b>${escapeHtml(String(d.level_pct??"—"))}%</b></div>
          <div class="hydro-kpi">Caudal: <b>${escapeHtml(String(d.flow_lps??"—"))} m³</b></div>
        </div>
      </div>
      <canvas class="hidro-canvas" id="${kind}-hidro-${escapeHtml(id)}" height="120"></canvas>
    </div>`;
  }).join("") || `<div class="muted">Sem equipamentos.</div>`;

  devices.forEach(d=>{
    const id=String(d.id);
    const canvas=$( `${kind}-hidro-${id}` );
    const series=getDeviceSeriesShort(kind, id).map(p=>({ flow_lps:p.flow_lps, level_pct:p.level_pct }));
    if(series.length<2){
    if(sbEnsureTelemetry(kind, id, ()=>renderHistorico())){ return; }

      const ctx=canvas.getContext("2d");
      const w=canvas.width = Math.max(320,(canvas.parentElement?.clientWidth||600)-4);
      ctx.clearRect(0,0,w,canvas.height);
      ctx.fillStyle="rgba(2,6,23,.7)";
      ctx.fillText("Sem dados suficientes.", 12, 24);
      return;
    }
    drawCombo(canvas, series, { barKey:"flow_lps", lineKey:"level_pct", barLabel:"Caudal (m³)", lineLabel:"Nível (%)", barColor:"rgba(37,99,235,.22)", lineColor:"rgba(212,175,55,.95)", lineDecimals:1 });
  });
}

function initHistoricoListeners(){
  const k=$("histKind"), d=$("histDevice"), a=$("histAgg"), r=$("histRange");
  if(k) k.onchange=()=>{ histDeviceOptions(true); renderHistorico(); };
  if(d) d.onchange=()=>renderHistorico();
  if(a) a.onchange=()=>renderHistorico();
  if(r) r.onchange=()=>renderHistorico();
}

// NOTE: password "eye" toggles are handled by a single delegated click handler
// registered in bootApp(). Keeping multiple handlers causes double-toggle.
function bindEyeToggles(){
  // no-op (kept for backward compatibility)
}

function bindHidroButtonsGlobal(){
  const a=$("btnDLHidro"); if(a) a.onclick=()=>showHidrogramas("dl", true);
  const b=$("btnCHidro"); if(b) b.onclick=()=>showHidrogramas("c", true);
}

function seedMeteoHistoryIfEmpty(){
  try{
    const h=getHist();
    if(h.meteo && h.meteo.length>=2) return;
    const arr=[];
    const now=Date.now();
    for(let i=60;i>=0;i--){
      const t=new Date(now - i*60*60000).toISOString();
      arr.push({t, p_mm_h:0, p_total_mm:0});
    }
    h.meteo = arr;
    save(LS.hist, h);
  }catch(e){}
}

function selectDashboardDeviceById(kind,id){
  const name = kind==="datalogger" ? (getDL().find(d=>String(d.id)===String(id))?.name||id)
             : (getC().find(c=>String(c.id)===String(id))?.name||id);
  selectDashboardDevice(kind,id,name);
}
window.selectDashboardDeviceById = selectDashboardDeviceById;

function wireHidrogramasButtons(){
  const a=$("btnDLHidro"); if(a) a.onclick=()=>{ showHidrogramas("dl", true); };
  const b=$("btnCHidro");  if(b) b.onclick=()=>{ showHidrogramas("c", true); };
}


/* PATCH2: Dashboard click on Data Logger -> show chart below (no modal) */
function selectDashboardDL(id){
  try{
    const d = getDL().find(x=>String(x.id)===String(id));
    const name = d?.name || id;
    const lbl = $("dashSelLabel"); if(lbl) lbl.textContent = `Selecionado: ${name}`;
    // Ensure chart canvas has stable sizing before drawing (prevents growth)
    const canvas=$("dashChart");
    if(canvas){
      const dpr=window.devicePixelRatio||1;
      const parentW = canvas.parentElement ? canvas.parentElement.clientWidth : 600;
      canvas.width = Math.max(320, parentW-4) * dpr;
      canvas.height = (Number(canvas.getAttribute("height"))||170) * dpr;
    }
    renderDashboardDeviceChart("datalogger", id);
  }catch(e){ console.error(e); }
}
window.selectDashboardDL = selectDashboardDL;

// Password eye toggles are wired in bootApp() via a delegated handler.

function downloadBlob(filename, blob){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href=url; a.download=filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 200);
}

function exportHistoricoExcel(){
  const dayStr = ($("histDate") && $("histDate").value) ? $("histDate").value : "";
  const kind=$("histKind").value;
  const devId=$("histDevice").value;
  const devName = (kind==="datalogger" ? (getDL().find(d=>String(d.id)===String(devId))?.name||devId)
                 : kind==="caudal" ? (getC().find(c=>String(c.id)===String(devId))?.name||devId)
                 : "Meteorologia");
  const series=getHistorySeries();
  const totalFlow = series.reduce((s,r)=> s + (Number(r.flow_lps)||0), 0);
  const totalPrecip = series.reduce((s,r)=> s + (Number(r.p_mm_h)||0), 0);

  const safe = String(devName).replace(/[^a-z0-9]+/gi,"_").replace(/^_+|_+$/g,"").slice(0,40) || "selecionado";
  const title = `ADNGEST • Histórico (${kind}) • ${devName}` + (dayStr? ` • ${dayStr}`:"");
  const rows = series.slice().reverse().map(r=>([r.t, r.level_pct??"", r.flow_lps??"", r.flow_total_m3??"", r.p_mm_h??"", r.p_total_mm??""]));
  const footer = dayStr ? [`TOTAL DO DIA`, "", totalFlow.toFixed(3), "", totalPrecip.toFixed(1), ""] : null;

  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <table border="1">
      <tr><th colspan="6">${escapeHtml(title)}</th></tr>
      <tr><th>Timestamp</th><th>Nível (%)</th><th>Caudal (m³)</th><th>Total Caudal (m³)</th><th>Precipitação (mm)</th><th>Total Precipitação (mm)</th></tr>
      ${rows.map(r=>`<tr>${r.map(c=>`<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")}
      ${footer ? `<tr>${footer.map(c=>`<td><b>${escapeHtml(String(c))}</b></td>`).join("")}</tr>` : ""}
    </table>
  </body></html>`;

  downloadBlob(`historico_${kind}_${safe}.xls`, new Blob([html],{type:"application/vnd.ms-excel"}));
  audit("EXPORT_XLSX",`Excel: ${kind} ${devName}` + (dayStr? ` ${dayStr}`:""));
}

const WEATHER_REFRESH_INTERVAL = 15*60*1000;
function startWeatherAutoRefresh(){
  try{
    if(startWeatherAutoRefresh._started) return;
    startWeatherAutoRefresh._started = true;
    // initial
    loadWeather().catch(()=>{ $("weatherMeta").textContent="Sem ligação ao servidor meteorológico."; });
    // periodic
    setInterval(()=>{ loadWeather().catch(()=>{ $("weatherMeta").textContent="Sem ligação ao servidor meteorológico."; }); }, WEATHER_REFRESH_INTERVAL);
    // when internet returns
    window.addEventListener("online", ()=>{ loadWeather().catch(()=>{}); });
  }catch(e){}
}
document.addEventListener("DOMContentLoaded", ()=>{ startWeatherAutoRefresh(); });

async function fetchNOAAAlert(){
  const el = $("noaaAlert");
  if(!el) return;
  try{
    el.textContent = "A obter alertas NOAA…";
    // Try NWS (NOAA) public API (CORS enabled)
    const url = "https://api.weather.gov/alerts/active?status=actual&message_type=alert";
    const res = await fetch(url, {cache:"no-store", headers: {"Accept":"application/geo+json"}});
    if(res.ok){
      const data = await res.json();
      const f = data.features && data.features[0];
      if(f && f.properties){
        const headline = f.properties.headline || f.properties.event || "Alerta ativo";
        el.textContent = headline.length>60 ? headline.slice(0,57)+"…" : headline;
        el.title = headline;
        return;
      }
    }
    // Fallback: show generic
    el.textContent = "Ver alertas no NOAA";
    el.title = "Sem alertas disponíveis via API.";
  }catch(e){
    el.textContent = "Sem ligação ao NOAA";
    el.title = "Não foi possível obter alertas do NOAA.";
  }
}
document.addEventListener("DOMContentLoaded", ()=>{ fetchNOAAAlert(); setInterval(fetchNOAAAlert, 30*60*1000); });

function scheduleWeatherRefresh(){
  // atualiza sempre que a Dashboard está ativa + quando volta a internet
  try{
    if(window.__wxTimer) clearInterval(window.__wxTimer);
    window.__wxTimer = setInterval(()=>{
      try{
        const active = !document.getElementById("tab-dashboard")?.classList.contains("hidden");
        if(active) loadWeather();
      }catch(e){}
    }, 10*60*1000); // 10 min
  }catch(e){}
}
window.addEventListener("online", ()=>{ try{ loadWeather(); }catch(e){} });
document.addEventListener("visibilitychange", ()=>{
  if(!document.hidden){ try{ loadWeather(); }catch(e){} }
});


function seedDemoHistory(days=30){
  try{
    const h = getHist();
    h.dl = h.dl || {};
    h.c  = h.c  || {};
    const dls = getDL();
    const cs  = getC();

    // Seed DL
    dls.forEach(d=>{
      const id = d.id;
      const arr = h.dl[id];
      if(!Array.isArray(arr) || arr.length<3){
        const loc = (d.localidade||d.municipio||"").trim();
        const met = getMeteoSeriesForLoc(loc);
        h.dl[id] = generateCorrelatedSeries("dl:"+id+":"+loc, met, days).map(p=>({t:p.t, level_pct:p.level_pct, flow_lps:p.flow_lps, rain_mm:p.rain_mm}));
      }
    });

    // Seed Caudalimetros
    cs.forEach(c=>{
      const id = c.id;
      const arr = h.c[id];
      if(!Array.isArray(arr) || arr.length<3){
        const loc = (c.localidade||c.municipio||"").trim();
        const met = getMeteoSeriesForLoc(loc);
        h.c[id] = generateCorrelatedSeries("c:"+id+":"+loc, met, days).map(p=>({t:p.t, level_pct:p.level_pct, flow_lps:p.flow_lps, rain_mm:p.rain_mm}));
      }
    });

    save(LS.hist, h);
  }catch(e){}
}

function seedDemoMeteo(days=30){
  try{ updateMeteoHist1yForAllLocalities(); }catch(e){}

  try{
    // store meteo demo in same place the app reads for meteo history
    const key = "adngest_meteo_hist_v1";
    const cur = JSON.parse(localStorage.getItem(key) || "{}");
    cur.locs = cur.locs || {};
    // derive localities from devices
    const locs = new Set();
    try{ getDL().forEach(d=>{ if(d.municipio) locs.add(d.municipio); }); }catch(e){}
    try{ getC().forEach(c=>{ if(c.municipio) locs.add(c.municipio); }); }catch(e){}
    if(locs.size===0) locs.add("Localidade");
    locs.forEach(loc=>{
      const arr = cur.locs[loc];
      if(!Array.isArray(arr) || arr.length<3){
        cur.locs[loc] = generateDemoMeteoSeries("meteo:"+loc, days).map(p=>({t:p.t, rain_mm:p.rain_mm}));
      }
    });
    localStorage.setItem(key, JSON.stringify(cur));
  }catch(e){}
}
function meteoDrivenTick(){
  // Hourly evolution driven by precipitation (Open-Meteo). If it rains, level/flow increase; if dry, they decrease.
  try{
    ensureHistoricoData();

    // Keep weather cache reasonably fresh (best-effort)
    try{ void updateMeteoForAllLocalities(); }catch(_e){}

    const h=getHist();
    const nowMs = Date.now();
    const hourMs = Math.floor(nowMs/3600000)*3600000;

    // wetness state persisted per device
    const wetKey = "adngest_wetness_v1";
    let wetState={};
    try{ wetState = JSON.parse(localStorage.getItem(wetKey)||"{}"); }catch(e){ wetState={}; }

    const cache = getMeteoCache();
    const getRainMmHour = (loc)=>{
      const k=(loc||"").trim();
      const it = (k && cache && cache[k]) ? cache[k] : null;
      if(!it || !it.hourly || !Array.isArray(it.hourly.time) || !Array.isArray(it.hourly.precipitation)) return 0;
      const times = it.hourly.time;
      const prec = it.hourly.precipitation;
      let best=-1, bestDiff=1e18;
      for(let i=0;i<times.length;i++){
        const tms = Date.parse(times[i]);
        const diff = Math.abs(tms - hourMs);
        if(diff < bestDiff){ bestDiff = diff; best=i; }
      }
      if(best<0 || bestDiff > 70*60*1000) return 0; // too far -> treat as dry
      const mm = Number(prec[best] ?? 0) || 0;
      return Math.max(0, mm);
    };

    const applyOne = (kind, dev, arr)=>{
      // If SCADA link exists, do not overwrite with simulated values.
      if(dev.scada_url && String(dev.scada_url).trim()) return;
      if(!Array.isArray(arr) || !arr.length) return;
      const last = arr[arr.length-1];
      const lastMs = new Date(last.t).getTime();
      if(lastMs >= hourMs) return; // already updated this hour

      const loc = (dev.localidade||dev.municipio||"").trim();
      const rain = getRainMmHour(loc);

      const stateKey = `${kind}:${dev.id}`;
      let wet = Number(wetState[stateKey] ?? 0) || 0;
      // rain increases wetness; dryness decays it
      wet = wet * 0.92 + rain * 1.6;
      wet = Math.max(0, Math.min(60, wet));
      wetState[stateKey] = +wet.toFixed(4);

      const prevL = Number(last.level_pct||0);
      const prevF = Number(last.flow_lps||0);

      // Core dynamics:
      // - rain contributes immediately
      // - wetness contributes as slower storage/release
      // - dryness is a constant decay when rain is ~0
      const dry = (rain<=0.01) ? 0.35 : 0.10;
      let lvl  = prevL + (rain*2.2) + (wet*0.04) - dry;
      let flow = prevF + (rain*0.75) + (wet*0.015) - (dry*0.18);

      lvl = Math.min(99, Math.max(1, lvl));
      flow = Math.max(0, flow);

      const point = { t: new Date(hourMs).toISOString(), level_pct: +lvl.toFixed(1), flow_lps: +flow.toFixed(2), raw: { rain_mm_h: +rain.toFixed(2) } };
      arr.push(point);
      if(arr.length>200000) arr.splice(0, arr.length-200000);
      dev.level_pct = point.level_pct;
      dev.flow_lps = point.flow_lps;

      // Persist locally
      if(kind==="datalogger") h.dl[dev.id]=arr;
      else h.c[dev.id]=arr;

      // Persist to Supabase (best-effort)
      try{ if(sbEnabled()) void sbInsertTelemetryPoint(kind, dev.id, point).catch(()=>{}); }catch(e){}
    };

    const dls = getDL();
    const cs  = getC();
    h.dl = h.dl || {};
    h.c  = h.c  || {};
    dls.forEach(d=>applyOne("datalogger", d, h.dl[d.id]));
    cs.forEach(c=>applyOne("caudal", c, h.c[c.id]));

    setHist(h);
    setDL(dls);
    setC(cs);
    try{ localStorage.setItem(wetKey, JSON.stringify(wetState)); }catch(e){}

    // refresh UI if on relevant tabs
    try{ renderDashboard(); }catch(e){}
    try{ if(!document.getElementById("tab-historico")?.classList.contains("hidden")) renderHistorico(); }catch(e){}
  }catch(e){}
}

function startMeteoDrivenUpdates(){
  try{
    if(window.__meteoDrivenTimer) return;
    // Check frequently but only write when a new hour starts.
    window.__meteoDrivenTimer = setInterval(meteoDrivenTick, 5*60*1000);
  }catch(e){}
}

/* ---------------- Ferramentas (v66) ---------------- */

// Local storage keys
LS.alertRules = "adngest_alert_rules_v1";
LS.userRoles  = "adngest_user_roles_v1";
LS.apiKeys    = "adngest_api_keys_v1";

function allDevicesList(){
  const out=[];
  getDL().forEach(d=>out.push({id:String(d.id), kind:"datalogger", name:d.name||d.id}));
  getC().forEach(c=>out.push({id:String(c.id), kind:"caudal", name:c.name||c.id}));
  return out;
}

function fillSelect(el, items, sel){
  if(!el) return;
  el.innerHTML = "";
  items.forEach(it=>{
    const o=document.createElement("option");
    o.value = it.id;
    o.textContent = `${it.name} (${it.kind==='datalogger'?'DL':'C'})`;
    el.appendChild(o);
  });
  if(sel){ el.value = sel; }
}

function canSeeRolesTool(){
  return !!(isAdmin() || hasPerm("tools_roles") || hasPerm(PERMS.ADMIN));
}
function canSeeApiTool(){
  return !!(isAdmin() || hasPerm("tools_api") || hasPerm(PERMS.ADMIN));
}
function applyToolsVisibility(){
  try{
    const rolesPanel = $("tblRoles")?.closest?.(".panel");
    if(rolesPanel) rolesPanel.style.display = canSeeRolesTool() ? "" : "none";
    const apiPanel = $("tblApiKeys")?.closest?.(".panel");
    if(apiPanel) apiPanel.style.display = canSeeApiTool() ? "" : "none";
  }catch(e){}
}

function initFerramentas(){
  const devs = allDevicesList();
  fillSelect($("alertDevice"), devs);
  fillSelect($("expDevice"), devs);
  fillSelect($("cmpA"), devs);
  fillSelect($("cmpB"), devs);
  fillSelect($("trendDevice"), devs);
  fillSelect($("anaDevice"), devs);

  // Radar foi movido para o mapa da Dashboard (botão "Radar de chuva")

  // Wire buttons
  if($("btnAlertsRefresh")) $("btnAlertsRefresh").onclick=()=>{ void refreshAlertRules(); };
  if($("btnAlertAdd")) $("btnAlertAdd").onclick=()=>{ void addAlertRuleFromUI(); };
  if($("btnAlertTest")) $("btnAlertTest").onclick=()=>{ triggerAlarm({ title:"Teste de alerta", body:"Alerta de teste (M.T®)", severity:"info" }); };

  if($("btnExportCsv")) $("btnExportCsv").onclick=()=>{ exportToolCsv(); };
  if($("btnCompare")) $("btnCompare").onclick=()=>{ renderCompare(); };
  if($("btnTrend")) $("btnTrend").onclick=()=>{ renderTrend(); };
  if($("btnRoleSave")) $("btnRoleSave").onclick=()=>{ void saveRoleFromUI(); };
  if($("btnRoleRefresh")) $("btnRoleRefresh").onclick=()=>{ void refreshRoles(); };
  if($("btnCompactTop")) $("btnCompactTop").onclick=()=>{ toggleCompactMode(); };
  // Backward compatibility (older layouts)
  if($("btnCompact")) $("btnCompact").onclick=()=>{ toggleCompactMode(); };
  if($("btnApiKeyNew")) $("btnApiKeyNew").onclick=()=>{ void createApiKey(); };
  if($("btnApiKeyRefresh")) $("btnApiKeyRefresh").onclick=()=>{ void refreshApiKeys(); };
  if($("btnAnalyze")) $("btnAnalyze").onclick=()=>{ renderAnalysis(); };
  if($("btnMapHeat")) $("btnMapHeat").onclick=()=>{ void toggleHeatLayer(); };
  if($("btnMapRadar")) $("btnMapRadar").onclick=()=>{ void toggleDashRadar(); };
  if($("btnMapExportGeoJSON")) $("btnMapExportGeoJSON").onclick=()=>{ exportGeoJSON(); };

  // Access control (hide tools the current user cannot access)
  applyToolsVisibility();

  // Map secondary actions menu ("Mais") - keeps the dashboard clean
  if($("btnMapMore") && $("mapMorePanel")){
    const btn = $("btnMapMore");
    const panel = $("mapMorePanel");
    const close = ()=>{ panel.classList.add("hidden"); btn.setAttribute("aria-expanded","false"); };
    const toggle = ()=>{
      const open = panel.classList.contains("hidden");
      if(open){ panel.classList.remove("hidden"); btn.setAttribute("aria-expanded","true"); }
      else close();
    };
    btn.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); toggle(); };
    panel.addEventListener("click", (e)=>{ e.stopPropagation(); });
    document.addEventListener("click", (e)=>{
      if(panel.classList.contains("hidden")) return;
      if(panel.contains(e.target) || btn.contains(e.target)) return;
      close();
    });
  }

  // Initial loads
  void refreshAlertRules();
  void refreshRoles();
  void refreshApiKeys();

  // Periodic alert evaluation (every 5 minutes)
  if(!window.__alertTimer){
    window.__alertTimer = setInterval(()=>{ try{ evaluateAlerts(); }catch(e){} }, 5*60*1000);
    setTimeout(()=>{ try{ evaluateAlerts(); }catch(e){} }, 1200);
  }
}

async function updateRadarFrame(){
  // Prefer Leaflet overlay using RainViewer tiles (iframe often blocked by X-Frame-Options)
  const cfg = load(LS.config, {});
  const loc = load(LS.weatherLoc, null);
  const lat = loc?.lat ?? 41.44;
  const lng = loc?.lng ?? -8.29;
  const z = 7;

  // Create Leaflet map if container exists
  const mapEl = $("radarMap");
  if(mapEl && window.L){
    try{
      if(!window.__rvMap){
        mapEl.innerHTML = "";
        window.__rvMap = L.map(mapEl, { zoomControl:true }).setView([lat,lng], z);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "© OpenStreetMap"
        }).addTo(window.__rvMap);

        // If the map is created while its container is hidden/resized, Leaflet can render tiles partially.
        // Use a ResizeObserver + delayed invalidateSize to ensure a complete render.
        try{
          if(!window.__rvResizeObs && window.ResizeObserver){
            window.__rvResizeObs = new ResizeObserver(()=>{
              try{ window.__rvMap && window.__rvMap.invalidateSize(false); }catch(e){}
            });
            window.__rvResizeObs.observe(mapEl);
          }
        }catch(e){}
      }else{
        window.__rvMap.setView([lat,lng], z);
      }

      await refreshRainviewerOverlay();

      // Force full tile redraw (fix "aos bocados")
      try{ setTimeout(()=>{ try{ window.__rvMap && window.__rvMap.invalidateSize(true); }catch(e){} }, 80); }catch(e){}

      // Hide iframe fallback when map works
      const fr=$("radarFrame"); if(fr) fr.style.display="none";
      return;
    }catch(e){
      console.warn("RainViewer Leaflet overlay failed:", e);
    }
  }

  // Fallback: iframe (may be blocked by provider)
  const fr = $("radarFrame");
  if(!fr) return;
  fr.style.display="block";
  fr.src = `https://www.rainviewer.com/map.html?loc=${lat},${lng},${z}&layer=radar&sm=1&sn=1&hu=0`;
}

async function refreshRainviewerOverlay(){
  if(!window.__rvMap) return;
  try{
    const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", { cache:"no-store" });
    if(!res.ok) throw new Error("RainViewer API: " + res.status);
    const data = await res.json();
    const host = data.host || "https://tilecache.rainviewer.com";
    const frames = []
      .concat((data.radar && data.radar.past) ? data.radar.past : [])
      .concat((data.radar && data.radar.nowcast) ? data.radar.nowcast : []);
    if(!frames.length) throw new Error("Sem frames radar.");
    const last = frames[frames.length-1];
    const path = last.path || ("/v2/radar/" + last.time);
    const tileUrl = host.replace(/\/$/,"") + path + "/256/{z}/{x}/{y}/2/1_1.png";

    // Replace existing overlay
    if(window.__rvLayer){
      try{ window.__rvMap.removeLayer(window.__rvLayer); }catch(e){}
      window.__rvLayer = null;
    }
    window.__rvLayer = L.tileLayer(tileUrl, {
      opacity: 0.6,
      zIndex: 450,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 3,
      crossOrigin: true
    });
    window.__rvLayer.addTo(window.__rvMap);

    // Trigger a repaint after overlay attach (helps with partial tiles on some browsers)
    try{ setTimeout(()=>{ try{ window.__rvMap && window.__rvMap.invalidateSize(false); }catch(e){} }, 80); }catch(e){}

    // Timestamp label
    const tsEl = $("radarMeta");
    if(tsEl){
      const dt = last.time ? new Date(last.time*1000) : null;
      tsEl.textContent = dt ? ("Atualizado: " + dt.toISOString().slice(0,19).replace('T',' ')) : "Radar atualizado";
    }
  }catch(e){
    const tsEl = $("radarMeta");
    if(tsEl) tsEl.textContent = "Radar indisponível.";
    throw e;
  }
}

/* ---- Alerts ---- */

async function refreshAlertRules(){
  const rules = await loadAlertRules();
  renderAlertRules(rules);
}

async function loadAlertRules(){
  let rules = load(LS.alertRules, []);
  // Pull from Supabase if available
  if(sbEnabled()){
    try{
      const data = await sbSelect("alert_rules", { select:"*", order:"id.desc", limit:200 });
      if(Array.isArray(data)){
        rules = data.map(r=>({
          id: r.id,
          user_email: r.user_email||"",
          device_id: r.device_id||"",
          metric: r.metric,
          op: r.op,
          threshold: Number(r.threshold),
          is_enabled: r.is_enabled!==false
        }));
        save(LS.alertRules, rules);
      }
    }catch(e){
      // Keep local rules if SB read fails
      console.warn("Supabase alert_rules select failed:", e);
    }
  }
  return rules;
}

function renderAlertRules(rules){
  const tb = $("tblAlerts")?.querySelector("tbody");
  if(!tb) return;
  const devs = allDevicesList();
  const nameById = Object.fromEntries(devs.map(d=>[d.id, d.name]));
  tb.innerHTML = "";
  if(!rules || rules.length===0){
    tb.innerHTML = `<tr><td colspan="5" class="muted small">Sem regras.</td></tr>`;
    return;
  }
  rules.forEach(r=>{
    const tr=document.createElement("tr");
    const metricLbl = r.metric==='level'?'Nível (%)':(r.metric==='flow'?'Caudal (m³)':'Chuva (mm/h)');
    tr.innerHTML = `<td>${esc(nameById[r.device_id]||r.device_id||"—")}</td><td>${esc(metricLbl)}</td><td>${esc(r.op||"—")}</td><td>${fmtNum(r.threshold)}</td><td class="right"><button class="btn small" data-del-alert="${r.id}">Eliminar</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll("button[data-del-alert]").forEach(b=>{
    b.onclick=()=>{ const id=b.getAttribute("data-del-alert"); void deleteAlertRule(id); };
  });
}

async function addAlertRuleFromUI(){
  const devId = $("alertDevice")?.value;
  const metric = $("alertType")?.value;
  const op = $("alertOp")?.value;
  const thr = Number($("alertValue")?.value||0);
  if(!devId || !metric || !op || !isFinite(thr)) return;
  const sess = load(LS.session, {email:null});
  const rule = { id: Date.now(), user_email: sess.email||"", device_id: devId, metric, op, threshold: thr, is_enabled:true };
  let rules = load(LS.alertRules, []);
  rules.unshift(rule);
  save(LS.alertRules, rules);
  if(sbEnabled()){
    try{
      await sbInsert("alert_rules", { user_email: rule.user_email, device_id: rule.device_id, metric: rule.metric, op: rule.op, threshold: rule.threshold, is_enabled: true });
    }catch(e){}
  }
  await refreshAlertRules();
  evaluateAlerts();
}

async function deleteAlertRule(id){
  if(!id) return;
  let rules = load(LS.alertRules, []);
  rules = rules.filter(r=>String(r.id)!==String(id));
  save(LS.alertRules, rules);
  if(sbEnabled()){
    try{ await sbDelete("alert_rules", { id: Number(id) }); }catch(e){ toastErr(e.message||e); }
  }
  renderAlertRules(rules);
}

function compareOp(v, op, thr){
  if(op===">=") return v>=thr;
  if(op===">") return v>thr;
  if(op==="<=") return v<=thr;
  if(op==="<") return v<thr;
  return false;
}

function triggerAlarm({title, body, severity}){
  try{
    $("alarmTitle").textContent = title||"Alarme";
    $("alarmBody").innerHTML = `<div class="pill" style="margin-bottom:8px">${esc(severity||"info")}</div><div>${esc(body||"")}</div>`;
    openDialog("dlgAlarm");
  }catch(e){ alert(`${title||"Alarme"}: ${body||""}`); }
}

async function evaluateAlerts(){
  const rules = await loadAlertRules();
  if(!rules || rules.length===0) return;
  const now = Date.now();
  const h = getHist();
  const met = load(LS.meteoHourly, {});
  const cfg = load(LS.config, {});
  const locKey = (cfg.weather_city||cfg.weatherCity||"Guimarães");
  const metArr = met[locKey]||[];
  const lastRain = metArr.length? Number(metArr[metArr.length-1].precipitation_mm||0):0;
  for(const r of rules){
    if(r.is_enabled===false) continue;
    let val = null;
    if(r.metric==="rain") val = lastRain;
    else{
      const kind = (getDL().some(d=>String(d.id)===String(r.device_id))) ? "datalogger" : "caudal";
      const series = (kind==="datalogger" ? (h.dl?.[r.device_id]||[]) : (h.c?.[r.device_id]||[]));
      const last = series.length ? series[series.length-1] : null;
      if(!last) continue;
      if(r.metric==="level") val = Number(last.level_pct ?? last.level_pct);
      if(r.metric==="flow")  val = Number(last.flow_lps ?? last.flow_lps);
    }
    if(val==null || !isFinite(val)) continue;
    if(compareOp(val, r.op, Number(r.threshold))){
      const k = `__alert_last_${r.id}`;
      const lastTs = Number(localStorage.getItem(k)||0);
      if(now - lastTs < 30*60*1000) continue; // throttle 30 min
      localStorage.setItem(k, String(now));
      const metricLbl = r.metric==='level'?'Nível (%)':(r.metric==='flow'?'Caudal':'Chuva (mm/h)');
      triggerAlarm({ title:"Alerta", body:`${metricLbl} ${r.op} ${fmtNum(r.threshold)} (atual: ${fmtNum(val)})`, severity:"warning" });
      try{ await sendExternalAlert({ rule:r, value:val, ts:new Date().toISOString() }); }catch(e){}
    }
  }
}

async function sendExternalAlert(payload){
  const cfg = load(LS.config, {});
  const url = (cfg.ext_alert_url||"").trim();
  if(!url) return;
  const method = (cfg.ext_alert_method||"POST").toUpperCase();
  const token = (cfg.ext_alert_token||"").trim();
  const headers = { "Content-Type":"application/json" };
  if(token) headers["Authorization"] = token;
  await fetch(url, { method, headers, body: method==="GET"?undefined:JSON.stringify(payload) });
}

/* ---- Export CSV (tool) ---- */

function exportToolCsv(){
  const devId = $("expDevice")?.value;
  const range = $("expRange")?.value||"year";
  if(!devId) return;
  const h = getHist();
  const kind = (getDL().some(d=>String(d.id)===String(devId))) ? "datalogger" : "caudal";
  const series = (kind==="datalogger" ? (h.dl?.[devId]||[]) : (h.c?.[devId]||[]));
  const filtered = filterByRange(series, range);
  const rows = ["ts,level_pct,flow_m3"];
  filtered.forEach(p=>{ rows.push(`${p.t},${Number(p.level_pct??"")},${Number(p.flow_lps??"")}`); });
  downloadText(`export_${devId}_${range}.csv`, rows.join("\n"));
}

function filterByRange(series, range){
  const now = new Date();
  let start = 0;
  if(range==="day") start = now.getTime()-24*3600*1000;
  if(range==="week") start = now.getTime()-7*24*3600*1000;
  if(range==="month") start = now.getTime()-30*24*3600*1000;
  if(range==="year") start = now.getTime()-365*24*3600*1000;
  if(range==="all") start = 0;
  return (series||[]).filter(p=> Date.parse(p.t) >= start);
}

function downloadText(filename, content){
  const blob = new Blob([content], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 50);
}

/* ---- Compare ---- */

async function renderCompare(){
  const a = $("cmpA")?.value; const b = $("cmpB")?.value;
  if(!a || !b) return;

  // Ensure we have data (pull from Supabase if configured)
  try{
    if(sbEnabled()){
      const kindA = (getDL().some(d=>String(d.id)===String(a))) ? "datalogger" : "caudal";
      const kindB = (getDL().some(d=>String(d.id)===String(b))) ? "datalogger" : "caudal";
      await sbLoadTelemetryIntoHist(a, kindA);
      await sbLoadTelemetryIntoHist(b, kindB);
    }else{
      // Ensure local seed exists
      try{ ensureSeedSixMonths(); }catch(e){}
    }
  }catch(e){
    console.warn("Compare pull failed:", e);
  }

  const h = getHist();
  const sA = (getDL().some(d=>String(d.id)===String(a)) ? (h.dl?.[a]||[]) : (h.c?.[a]||[]));
  const sB = (getDL().some(d=>String(d.id)===String(b)) ? (h.dl?.[b]||[]) : (h.c?.[b]||[]));
  const A = filterByRange(sA, "week");
  const B = filterByRange(sB, "week");

  if(A.length<2 || B.length<2){
    if($("cmpLegend")) $("cmpLegend").innerHTML = `<span class="muted small">Sem dados suficientes para comparação.</span>`;
    const ctx=$("cmpChart")?.getContext?.("2d"); if(ctx){ ctx.clearRect(0,0,$("cmpChart").width,$("cmpChart").height); }
    return;
  }

  const n = Math.min(A.length, B.length, 500);
  const combo=[];
  for(let i=Math.max(0,n-72); i<n; i++){
    combo.push({ t: (A[i]?.t||"").slice(0,16).replace('T',' ')||"", line: Number(A[i]?.level_pct||0), bar: Number(B[i]?.level_pct||0) });
  }
  drawCombo($("cmpChart"), combo, { title:"Comparação (Nível)", lineKey:"line", barKey:"bar", lineLabel:"Equip. A (Nível)", barLabel:"Equip. B (Nível)", lineDecimals:1, barDecimals:1 });
  if($("cmpLegend")) $("cmpLegend").innerHTML = `<span class="swatch" style="background:rgba(212,175,55,.95)"></span>A (Nível) <span class="swatch" style="background:rgba(37,99,235,.22);margin-left:10px"></span>B (Nível)`;
}

/* ---- Trends & Forecast ---- */

function movingAvg(values, win){
  const out=[];
  for(let i=0;i<values.length;i++){
    const a = Math.max(0, i-win+1);
    const slice = values.slice(a, i+1);
    const m = slice.reduce((s,v)=>s+v,0)/Math.max(1,slice.length);
    out.push(m);
  }
  return out;
}

function renderTrend(){
  const id = $("trendDevice")?.value;
  const win = Math.max(3, Number($("trendWindow")?.value||24));
  if(!id) return;
  const h=getHist();
  const series = (getDL().some(d=>String(d.id)===String(id)) ? (h.dl?.[id]||[]) : (h.c?.[id]||[]));
  const last = filterByRange(series, "week");
  const slice = last.slice(Math.max(0,last.length-168)); // 7d hourly
  const vals = slice.map(p=>Number(p.level_pct||0));
  const ma = movingAvg(vals, win);
  // simple projection: extend 24h using last slope
  const tNow = slice.length? Date.parse(slice[slice.length-1].t):Date.now();
  const slope = (vals.length>2) ? (vals[vals.length-1]-vals[vals.length-25>0?vals.length-25:0])/Math.min(24,vals.length-1) : 0;
  const combo=[];
  for(let i=0;i<slice.length;i++) combo.push({ t: slice[i].t.slice(11,16), line: vals[i], bar: ma[i] });
  // append forecast (24h)
  let lastVal = vals[vals.length-1]||0;
  let lastMa = ma[ma.length-1]||0;
  for(let k=1;k<=24;k++){
    lastVal = Math.max(0, lastVal + slope);
    lastMa = Math.max(0, lastMa + slope*0.8);
    const tt = new Date(tNow + k*3600*1000).toISOString().slice(11,16);
    combo.push({ t: tt, line: lastVal, bar: lastMa });
  }
  drawCombo($("trendChart"), combo, { title:"Tendência + previsão (Nível)", lineKey:"line", barKey:"bar", lineLabel:"Nível (%)", barLabel:`Média móvel (${win}h)`, lineDecimals:1, barDecimals:1 });
  if($("trendLegend")) $("trendLegend").innerHTML = `<span class="swatch" style="background:rgba(212,175,55,.95)"></span>Nível (%) <span class="swatch" style="background:rgba(37,99,235,.22);margin-left:10px"></span>Média móvel`;
}

/* ---- Roles ---- */

async function refreshRoles(){
  let roles = load(LS.userRoles, []);
  if(sbEnabled()){
    try{
      const data = await sbSelect("user_roles", { select:"*" });
      if(Array.isArray(data)){
        roles = data.map(r=>({ email:String(r.email||"").toLowerCase(), role:r.role }));
        save(LS.userRoles, roles);
      }
    }catch(e){
      console.warn("Supabase user_roles select failed:", e);
      try{ if(sbIsMissingTableError(e)) sbWarnMissingTableOnce("public.user_roles"); }catch(_e){}
    }
  }
  renderRoles(roles);
  // Apply current user's role to permission system
  try{ applyRoleFromStore(); }catch(e){}
}

function renderRoles(roles){
  const tb = $("tblRoles")?.querySelector("tbody");
  if(!tb) return;
  tb.innerHTML = "";
  if(!roles || roles.length===0){ tb.innerHTML = `<tr><td colspan="3" class="muted small">Sem roles.</td></tr>`; return; }
  roles.sort((a,b)=>a.email.localeCompare(b.email)).forEach(r=>{
    const tr=document.createElement("tr");
    tr.innerHTML = `<td>${esc(r.email)}</td><td>${esc(r.role)}</td><td class="right"><button class="btn small" data-del-role="${esc(r.email)}">Eliminar</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll("button[data-del-role]").forEach(b=>{
    b.onclick=()=>{ void deleteRole(b.getAttribute("data-del-role")); };
  });
}

async function saveRoleFromUI(){
  if(!(isAdmin() || hasPerm("tools_roles") || hasPerm(PERMS.ADMIN))) { alert("Sem permissões."); return; }
  const email = ($("roleEmail")?.value||"").trim().toLowerCase();
  const role  = $("roleValue")?.value||"viewer";
  if(!email) return;
  let roles = load(LS.userRoles, []);
  roles = roles.filter(r=>r.email!==email);
  roles.push({email, role});
  save(LS.userRoles, roles);
  if(sbEnabled()){
    try{ await sbDelete("user_roles", { email }); }catch(e){
      try{ if(sbIsMissingTableError(e)) sbWarnMissingTableOnce("public.user_roles"); }catch(_e){}
    }
    try{ await sbInsert("user_roles", { email, role }); }catch(e){
      try{ if(sbIsMissingTableError(e)) sbWarnMissingTableOnce("public.user_roles"); }catch(_e){}
      toastErr(e.message||e);
    }
  }
  await refreshRoles();
}

async function deleteRole(email){
  if(!(isAdmin() || hasPerm("tools_roles") || hasPerm(PERMS.ADMIN))) { alert("Sem permissões."); return; }
  email = String(email||"").toLowerCase();
  let roles = load(LS.userRoles, []);
  roles = roles.filter(r=>r.email!==email);
  save(LS.userRoles, roles);
  if(sbEnabled()){
    try{ await sbDelete("user_roles", { email }); }catch(e){
      try{ if(sbIsMissingTableError(e)) sbWarnMissingTableOnce("public.user_roles"); }catch(_e){}
      toastErr(e.message||e);
    }
  }
  renderRoles(roles);
  try{ applyRoleFromStore(); }catch(e){}
}

function applyRoleFromStore(){
  const sess = load(LS.session, {email:null});
  const email = (sess.email||"").toLowerCase();
  const roles = load(LS.userRoles, []);
  const r = roles.find(x=>x.email===email);
  if(r && r.role){
    window.__roleOverride = r.role;
  }
  // Re-evaluate UI permissions
  try{ applyAdminOnlyVisibility(); }catch(e){}
  try{ applyToolsVisibility(); }catch(e){}
}

// Override isAdmin/canEditKind to include role override
const __isAdminOrig = isAdmin;
isAdmin = function(){
  if(window.__roleOverride) return window.__roleOverride==="admin";
  return __isAdminOrig();
};

const __canEditKindOrig = canEditKind;
canEditKind = function(kind){
  if(window.__roleOverride==="viewer") return false;
  if(window.__roleOverride==="operator") return true;
  return __canEditKindOrig(kind);
};

/* ---- Compact mode ---- */

// "Modo Mobile" behaviour:
// - Automatic on small screens when the user has not manually overridden.
// - Manual toggle persists and disables automatic switching until reset.
const COMPACT_KEY = "adngest_compact";
const COMPACT_MANUAL_KEY = "adngest_compact_manual";
const COMPACT_BREAKPOINT_PX = 768;

function applyAutoCompactMode(){
  try{
    const manual = localStorage.getItem(COMPACT_MANUAL_KEY)==="1";
    if(manual) return;
    const shouldCompact = (window.innerWidth||9999) <= COMPACT_BREAKPOINT_PX;
    document.body.classList.toggle("compact", shouldCompact);
    // Persist last auto state for consistency (does not mark as manual)
    try{ localStorage.setItem(COMPACT_KEY, shouldCompact?"1":"0"); }catch(e){}
  }catch(e){}
}

function toggleCompactMode(){
  document.body.classList.toggle("compact");
  try{ localStorage.setItem(COMPACT_MANUAL_KEY, "1"); }catch(e){}
  try{ localStorage.setItem(COMPACT_KEY, document.body.classList.contains("compact")?"1":"0"); }catch(e){}
}

// Init compact mode:
// - If the user has manually set a preference, use it.
// - Otherwise, switch automatically by viewport width.
try{
  const manual = localStorage.getItem(COMPACT_MANUAL_KEY)==="1";
  if(manual){
    if(localStorage.getItem(COMPACT_KEY)==="1") document.body.classList.add("compact");
  }else{
    applyAutoCompactMode();
    window.addEventListener("resize", applyAutoCompactMode);
    window.addEventListener("orientationchange", applyAutoCompactMode);
  }
}catch(e){}

/* ---- API keys ---- */

function genApiKey(){
  const a = crypto?.getRandomValues ? crypto.getRandomValues(new Uint8Array(24)) : Array.from({length:24},()=>Math.floor(Math.random()*256));
  return Array.from(a).map(x=>x.toString(16).padStart(2,"0")).join("");
}

async function refreshApiKeys(){
  let keys = load(LS.apiKeys, []);
  if(sbEnabled()){
    try{
      const data = await sbSelect("api_keys", { select:"*", order:"created_at.desc", limit:50 });
      if(Array.isArray(data)){
        keys = data.filter(k=>k.is_revoked!==true).map(k=>({ id:k.id, api_key:k.api_key, created_at:k.created_at }));
        save(LS.apiKeys, keys);
      }
    }catch(e){
      console.warn("Supabase api_keys select failed:", e);
      try{ if(sbIsMissingTableError(e)) sbWarnMissingTableOnce("public.api_keys"); }catch(_e){}
    }
  }
  renderApiKeys(keys);
}

function renderApiKeys(keys){
  const tb = $("tblApiKeys")?.querySelector("tbody");
  if(!tb) return;
  tb.innerHTML = "";
  if(!keys || keys.length===0){ tb.innerHTML = `<tr><td colspan="3" class="muted small">Sem chaves.</td></tr>`; return; }
  keys.forEach(k=>{
    const tr=document.createElement("tr");
    const short = String(k.api_key||"").slice(0,6)+"…"+String(k.api_key||"").slice(-4);
    tr.innerHTML = `<td><code title="${esc(k.api_key)}">${esc(short)}</code></td><td>${esc(String(k.created_at||"").slice(0,19).replace('T',' '))}</td><td class="right"><button class="btn small" data-rev-key="${k.id}">Revogar</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll("button[data-rev-key]").forEach(b=>{
    b.onclick=()=>{ void revokeApiKey(b.getAttribute("data-rev-key")); };
  });
}

async function createApiKey(){
  if(!(isAdmin() || hasPerm("tools_api") || hasPerm(PERMS.ADMIN))) { alert("Sem permissões."); return; }
  const key = genApiKey();
  const sess = load(LS.session, {email:null});
  let keys = load(LS.apiKeys, []);
  keys.unshift({ id: Date.now(), api_key:key, created_at:new Date().toISOString() });
  save(LS.apiKeys, keys);
  if(sbEnabled()){
    try{ await sbInsert("api_keys", { api_key: key, created_by: sess.email||"" }); }
    catch(e){
      try{ if(sbIsMissingTableError(e)) sbWarnMissingTableOnce("public.api_keys"); }catch(_e){}
      toastErr(e.message||e);
    }
  }
  await refreshApiKeys();
  triggerAlarm({ title:"API Key", body:`Chave criada: ${key}`, severity:"info" });
}

async function revokeApiKey(id){
  if(!(isAdmin() || hasPerm("tools_api") || hasPerm(PERMS.ADMIN))) { alert("Sem permissões."); return; }
  let keys = load(LS.apiKeys, []);
  keys = keys.filter(k=>String(k.id)!==String(id));
  save(LS.apiKeys, keys);
  if(sbEnabled()){
    try{ await sbUpdate("api_keys", { is_revoked:true }, { id: Number(id) }); }
    catch(e){
      try{ if(sbIsMissingTableError(e)) sbWarnMissingTableOnce("public.api_keys"); }catch(_e){}
      toastErr(e.message||e);
    }
  }
  renderApiKeys(keys);
}

/* ---- Analysis ---- */

function corr(a,b){
  const n=Math.min(a.length,b.length);
  if(n<3) return NaN;
  const aa=a.slice(-n), bb=b.slice(-n);
  const ma=aa.reduce((s,v)=>s+v,0)/n;
  const mb=bb.reduce((s,v)=>s+v,0)/n;
  let num=0, da=0, db=0;
  for(let i=0;i<n;i++){
    const xa=aa[i]-ma, xb=bb[i]-mb;
    num += xa*xb; da += xa*xa; db += xb*xb;
  }
  return num/Math.sqrt(da*db||1);
}

function zScores(values){
  const n=values.length;
  const m=values.reduce((s,v)=>s+v,0)/Math.max(1,n);
  const v=values.reduce((s,x)=>s+(x-m)*(x-m),0)/Math.max(1,n);
  const sd=Math.sqrt(v||0.0001);
  return values.map(x=>(x-m)/sd);
}

function renderAnalysis(){
  const id = $("anaDevice")?.value;
  const zThr = Number($("anaZ")?.value||3);
  if(!id) return;
  const h=getHist();
  const series = (getDL().some(d=>String(d.id)===String(id)) ? (h.dl?.[id]||[]) : (h.c?.[id]||[]));
  const slice = filterByRange(series, "week");
  const flow = slice.map(p=>Number(p.flow_lps||0));
  const zs = zScores(flow);
  const anomalies = zs.map((z,i)=>({z, i})).filter(x=>Math.abs(x.z)>=zThr).slice(-10);
  // correlation with rain (last 7 days)
  const cfg=load(LS.config,{});
  const locKey = (cfg.weather_city||cfg.weatherCity||"Guimarães");
  const met = load(LS.meteoHourly, {});
  const metArr = (met[locKey]||[]).slice(-slice.length);
  const rain = metArr.map(p=>Number(p.precipitation_mm||0));
  const c = corr(rain, flow);
  const out = [];
  out.push(`Correlação chuva×caudal (aprox.): ${isFinite(c)?c.toFixed(2):"—"}`);
  out.push(`Anomalias (z≥${zThr}): ${anomalies.length}`);
  if(anomalies.length){
    const lastA = anomalies[anomalies.length-1];
    const ts = slice[lastA.i]?.t;
    out.push(`Última anomalia: ${ts?ts.replace('T',' ').slice(0,19):"—"} (z=${lastA.z.toFixed(2)})`);
  }
  $("anaOut").textContent = out.join(" | ");
}

/* ---- Map advanced ---- */

let __heatLayer=null;
let __heatTimer=null;

function buildHeatLayerFromLatest(latestById){
  const grp = L.layerGroup();
  const dls=getDL();
  dls.forEach(d=>{
    if(d.lat==null || d.lng==null) return;
    const last = latestById?.[String(d.id)] || null;
    const lvl = Number(last?.level_pct ?? d.level_pct ?? 0);
    const radius = 200 + (lvl*25);
    const c = L.circle([d.lat,d.lng], { radius, opacity:0.25, fillOpacity:0.12 });
    grp.addLayer(c);
  });
  const cs=getC();
  cs.forEach(d=>{
    if(d.lat==null || d.lng==null) return;
    const last = latestById?.[String(d.id)] || null;
    const lvl = Number(last?.level_pct ?? d.level_pct ?? 0);
    const radius = 200 + (lvl*25);
    const c = L.circle([d.lat,d.lng], { radius, opacity:0.25, fillOpacity:0.12 });
    grp.addLayer(c);
  });
  return grp;
}

async function fetchLatestTelemetryForHeatmap(){
  // Best-effort: use Supabase if configured; fallback to local history.
  try{
    const cfg=getSbCfg();
    if(!cfg?.url || !cfg?.anon) throw new Error("no supabase");
    const since = new Date(Date.now() - 36*60*60*1000).toISOString();
    const rows = await sbRequest(`telemetry?select=device_id,ts,level_pct,flow_m3&ts=gte.${encodeURIComponent(since)}&order=ts.desc&limit=5000`, "GET");
    const latest = {};
    for(const r of (rows||[])){
      const id = String(r.device_id);
      if(!latest[id]) latest[id]=r;
    }
    return latest;
  }catch(e){
    const h=getHist();
    const latest = {};
    getDL().forEach(d=>{
      const s=(h.dl?.[d.id]||[]);
      if(s.length) latest[String(d.id)] = s[s.length-1];
    });
    getC().forEach(d=>{
      const s=(h.c?.[d.id]||[]);
      if(s.length) latest[String(d.id)] = s[s.length-1];
    });
    return latest;
  }
}

async function refreshHeatLayer(){
  if(!map || !__heatLayer) return;
  try{
    const latest = await fetchLatestTelemetryForHeatmap();
    const newLayer = buildHeatLayerFromLatest(latest);
    map.removeLayer(__heatLayer);
    __heatLayer = newLayer;
    newLayer.addTo(map);
  }catch(e){
    console.warn("Heatmap refresh failed", e);
  }
}

async function toggleHeatLayer(){
  if(!map) return;
  if(__heatLayer){
    map.removeLayer(__heatLayer);
    __heatLayer=null;
    if(__heatTimer){ clearInterval(__heatTimer); __heatTimer=null; }
    return;
  }
  const latest = await fetchLatestTelemetryForHeatmap();
  const grp = buildHeatLayerFromLatest(latest);
  __heatLayer = grp;
  grp.addTo(map);
  // Auto-refresh hourly from server/local.
  if(__heatTimer){ clearInterval(__heatTimer); }
  __heatTimer = setInterval(()=>{ void refreshHeatLayer(); }, 60*60*1000);
}

function exportGeoJSON(){
  const devs = [];
  getDL().forEach(d=>devs.push({ ...d, kind:"datalogger" }));
  getC().forEach(d=>devs.push({ ...d, kind:"caudal" }));
  const fc = {
    type:"FeatureCollection",
    features: devs.filter(d=>d.lat!=null && d.lng!=null).map(d=>({
      type:"Feature",
      geometry:{ type:"Point", coordinates:[Number(d.lng), Number(d.lat)] },
      properties:{ id:String(d.id), kind:d.kind, name:d.name||"", municipio:d.municipio||"" }
    }))
  };
  downloadText("equipamentos.geojson", JSON.stringify(fc, null, 2));
}



