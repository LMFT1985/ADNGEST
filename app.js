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
      alerts: { level: 90, email: true, sms: false }
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
    if(!cfg.alerts) cfg.alerts = { level: 90, email:true, sms:false };
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
  const email = ($("loginEmail").value || "").trim().toLowerCase();
  const pass  = ($("loginPass").value || "").trim();
  if(!email || !pass){ showLoginError("Preenche email e password."); return; }
  const users = load(LS.users, []);
  const u = users.find(x => String(x.email||"").toLowerCase()===email && String(x.password||"")===pass);
  if(!u){ showLoginError("Credenciais inválidas."); return; }
  save(LS.session, { email: u.email, at: nowISO() });
  audit("LOGIN", u.email);
  // Online presence (local-only): mark current user as online with heartbeat.
  markOnline();
  setAuthUI(true);
  applyNavPerms();
  refreshHeader();
  try{ applyNavPerms(); }catch(e){}
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
  if(tab==="historico"){ renderHistorico(); }
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
function setDL(list){ save(LS.dl, list); }
function getC(){
  const list = load(LS.c, []);
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
function setC(list){ save(LS.c, list); }

/* ---------- Map ---------- */
let map=null, layerOSM=null, layerSAT=null;
let markersDL = new Map();
let markersC = new Map();

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
  map.on("zoomend", updateMarkerIconsForZoom);
  layerOSM = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19, attribution:"© OpenStreetMap" });
  layerSAT = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom:19, attribution:"© Esri" });
  layerOSM.addTo(map);

  $("btnLayers").onclick = ()=> $("layersPanel").classList.toggle("hidden");
  qa('input[name="basemap"]').forEach(r=>{
    r.addEventListener("change", ()=>{
      const v = q('input[name="basemap"]:checked')?.value || "osm";
      if(v==="osm"){ map.removeLayer(layerSAT); layerOSM.addTo(map); }
      else { map.removeLayer(layerOSM); layerSAT.addTo(map); }
    });
  });
  $("btnFitAll").onclick = fitAll;
  $("btnMapFull").onclick = toggleMapFullscreen;
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
  $("btnExportKML").onclick = downloadKML;

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
    if(lp.classList.contains("hidden")) return;
    if(lp.contains(e.target) || btn.contains(e.target)) return;
    lp.classList.add("hidden");
  });

  renderMapMarkers();
  // ensure initial sizing uses the current zoom
  updateMarkerIconsForZoom();
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

/* Simulated data generation to feed history every minute (standalone) */
function tickSimulateHistory(){
  // generate one point per device every minute (in-memory manageable; stored bounded)
  const t=nowISO();
  const dls=getDL();
  const cs=getC();
  for(const d of dls){
    const level=clamp(Math.round(d.level_pct + (Math.random()*10-5)),0,100);
    const flow=+(Math.max(0, d.flow_lps + (Math.random()*20-10))).toFixed(1);
    d.level_pct=level; d.flow_lps=flow;
    writeDevicePoint("datalogger", d.id, { t, level_pct: level, flow_lps: flow });
    maybeTriggerAlert("datalogger", d);
  }
  for(const c of cs){
    const level=clamp(Math.round(c.level_pct + (Math.random()*10-5)),0,100);
    const flow=+(Math.max(0, c.flow_lps + (Math.random()*40-20))).toFixed(1);
    c.level_pct=level; c.flow_lps=flow;
    writeDevicePoint("caudal", c.id, { t, level_pct: level, flow_lps: flow });
    maybeTriggerAlert("caudal", c);
  }
  setDL(dls); setC(cs);
  // refresh map markers cheaply
  renderMapMarkers();
  renderDashboard();
}
let simTimer=null;

/* ---------- Alerts (stub for external server) ---------- */
function maybeTriggerAlert(kind, dev){
  const cfg=getCfg();
  const lim = Number(cfg.alerts?.level ?? 90);
  if(Number(dev.level_pct)>=lim){
    // log an alert event; external server hook would send email/SMS
    audit("ALERT", `${kind}:${dev.id} nível ${dev.level_pct}%`);
    // Placeholder hook:
    // window.sendAlertExternal?.({kind, device:dev, channels:cfg.alerts})
  }
}

/* ---------- Weather (Open-Meteo) ---------- */
function populateCities(){
  const dl=$("ptCities");
  dl.innerHTML = PT_CITY_SUGGESTIONS.map(c=>`<option value="${escapeHtml(c)}"></option>`).join("");
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
  h.meteo.push({ t: nowISO(), city: loc.name, t_c: idx>=0?hourly.temperature_2m[idx]:null, p_mm_h: idx>=0?hourly.precipitation[idx]:null });
  if(h.meteo.length>200000) h.meteo=h.meteo.slice(-200000);
  setHist(h);
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
  url.searchParams.set("forecast_days","0");
  const res = await fetch(url.toString(), {cache:"no-store"});
  if(!res.ok) throw new Error("HTTP "+res.status);
  const data = await res.json();
  const h = data.hourly || {};
  return { name: g.name||place, lat:g.lat, lng:g.lng, updatedAt: Date.now(), hourly:{ time:h.time||[], precipitation:h.precipitation||[] } };
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
      h.meteo.push({ t: nowIso, city, t_c: null, p_mm_h: pmm });
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
    <div class="quickitem" onclick="window.selectDashboardDeviceById('datalogger','${d.id}')">
      <div><b>${escapeHtml(d.name)}</b> • <span class="muted small">${escapeHtml(d.municipio)} — ${escapeHtml(d.rio)}</span></div>
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

  const minMaxFields = kind==="datalogger" ? `
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

    const lat=n2($("detLat").value); const lng=n2($("detLng").value);
    if(Number.isFinite(lat)) d.lat=+lat.toFixed(6);
    if(Number.isFinite(lng)) d.lng=+lng.toFixed(6);

    const lvl=n2($("detLevel").value);
    if(Number.isFinite(lvl)) d.level_pct=clamp(Math.round(lvl),0,100);

    const fl=n2($("detFlow").value);
    if(Number.isFinite(fl)) d.flow_lps=+(Math.max(0,fl).toFixed(1));

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

      // limites (mín./máx.) — gravar (Data Logger's)
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
}
function deleteDevice(kind, id){
  if(kind==="datalogger"){
    setDL(getDL().filter(x=>x.id!==id));
  }else{
    setC(getC().filter(x=>x.id!==id));
  }
  renderMapMarkers();
  renderDashboard();
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

window.editUser = function(uid){
  if(!isAdmin()){ alert("Apenas Administrador."); return; }
  const users=load(LS.users, []);
  const u=users.find(x=>x.id===uid);
  if(!u) return;

  openModal("Editar utilizador", `
    <div class="panel">
      <div class="toolbar">
        <div style="flex:1"><div class="muted small">Nome</div><input class="input" id="uName" value="${escapeHtml(u.name||"")}" /></div>
        <div style="flex:1"><div class="muted small">Telemóvel</div><input class="input" id="uPhone" value="${escapeHtml(u.phone||"")}" /></div>
      </div>
      <div class="toolbar">
        <div style="flex:1"><div class="muted small">Email</div><input class="input" id="uEmail" value="${escapeHtml(u.email||"")}" /></div>
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
  const be=$("btnEyeLogin"); if(be){ be.addEventListener("click", ()=>{}); }
  recoverInit();

  $("btnUSave").onclick=()=>{
    u.name=($("uName").value||"").trim();
    u.phone=($("uPhone").value||"").trim();
    u.email=($("uEmail").value||"").trim();
    u.password=($("uPass").value||"").trim();
    u.role=$("uRole").value;
    u.perms = qa(".uPerm").filter(x=>x.checked).map(x=>x.value);

    if(u.email.toLowerCase()===ADMIN_EMAIL.toLowerCase()){
      u.role="Administrador";
      u.perms=[PERMS.VIEW, PERMS.EDIT, PERMS.ADMIN, PERMS.DELETE];
      u.password=ADMIN_PASS;
    }
    save(LS.users, users);
    audit("EDIT_USER", u.email);
    closeModal();
    renderUsers();
  };
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
  const u = { id:"u-"+uuid(), name:"", email:"", phone:"", password:"", role:"Colaborador", perms:[PERMS.VIEW,"dash_view","dl_view","c_view","hist_view"] };
  const users=load(LS.users, []);
  users.push(u);
  save(LS.users, users);
  audit("ADD_USER", u.id);
  renderUsers();
  window.editUser(u.id);
}

/* ---------- Audit view ---------- */
const actionLabels={LOGIN:'Login efetuado',LOGOUT:'Logout',DEVICE_EDIT:'Alteração de equipamento',AUDIT_DELETE_ONE:'Eliminação de registo',USERS_UPDATE:'Alteração de utilizadores'};

function renderAudit(){
  const tbody=q("#tblAudit tbody");
  const list=load(LS.audit, []);

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

  const rows = filtered.slice().reverse().map(({e,i})=>{
    const a=String(e.action||"").toUpperCase();
    const tipo = a==="LOGIN" ? "Entrada" : (a==="LOGOUT" ? "Saída" : "Edição");
    const edited = (a==="LOGIN" || a==="LOGOUT") ? "" : (describeAuditEntry(e) || e.detail || e.action || "");
    const delBtn = isAdmin() ? `<button class="btn danger" type="button" data-audit-del="${i}">Eliminar</button>` : "";
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
      confirmBox("Eliminar registo", "Eliminar este registo do histórico? (irreversível)", ()=>{
        const cur=load(LS.audit, []);
        if(idx<0 || idx>=cur.length) return;
        cur.splice(idx,1);
        save(LS.audit, cur);
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
  $("cfgAlertLevel").value = cfg.alerts?.level ?? 90;
  $("cfgAlertEmail").checked = !!cfg.alerts?.email;
  $("cfgAlertSMS").checked = !!cfg.alerts?.sms;

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
    (h.meteo||[]).forEach(x=>{ if(x && x.city) names.add(String(x.city)); });
    const arr = Array.from(names).filter(Boolean).sort((a,b)=>a.localeCompare(b,"pt"));
    opts = arr.length ? arr.map(n=>({id:n,label:n})) : [{id:(cfgName||"Meteorologia"),label:(cfgName||"Meteorologia")}];
  }
  sel.innerHTML = opts.map(o=>`<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}</option>`).join("");
  if(prev && opts.find(o=>o.id===prev)) sel.value = prev;
  _histLastKind = kind;
}

function aggregate(points, unit){
  // points: [{t, level_pct, flow_lps, p_mm_h, ...}]
  // unit: minute/hour/day/week/month/year based on t bucket.
  const buckets=new Map();
  for(const p of points){
    const dt=new Date(p.t);
    let key="";
    if(unit==="minute"){
      key = dt.toISOString().slice(0,16); // YYYY-MM-DDTHH:MM
    }else if(unit==="hour"){
      key = dt.toISOString().slice(0,13); // hour
    }else if(unit==="day"){
      key = dt.toISOString().slice(0,10);
    }else if(unit==="week"){
      // ISO week approx
      const d = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
      const dayNum = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - dayNum + 3);
      const firstThursday = new Date(Date.UTC(d.getUTCFullYear(),0,4));
      const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3) / 7);
      key = `${d.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;
    }else if(unit==="month"){
      key = dt.toISOString().slice(0,7);
    }else if(unit==="year"){
      key = dt.toISOString().slice(0,4);
    }
    if(!buckets.has(key)) buckets.set(key, { t:key, n:0, level:0, flow:0, p:0, flow_liters:0, rain_mm:0 });
    const b=buckets.get(key);
    b.n++;
    b.level += Number(p.level_pct||0);
    b.flow  += Number(p.flow_lps||0);
    b.p     += Number(p.p_mm_h||0);
    // totals: points are 1-minute samples
    b.flow_liters += Number(p.flow_lps||0) * 60; // L
    b.rain_mm += Number(p.p_mm_h||0) / 60; // mm (from mm/h to mm per minute)
  }
  const arr = Array.from(buckets.values()).sort((a,b)=>a.t.localeCompare(b.t)).map(b=>({
    t: b.t,
    level_pct: b.n? +(b.level/b.n).toFixed(1) : null,
    flow_lps:  b.n? +(b.flow/b.n).toFixed(1) : null,
    p_mm_h:    b.n? +(b.p/b.n).toFixed(2) : null,
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
    // Meteorologia: filtrar por localidade selecionada
    const city = id;
    points = (h.meteo||[])
      .filter(x=> !city || (String(x.city||"")===String(city)) )
      .map(x=>({t:x.t, p_mm_h:x.p_mm_h, p_total_mm:x.p_total_mm??null, level_pct:null, flow_lps:null}));
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

  return aggregate(points, agg);
}

function renderHistorico(){
  histDeviceOptions(false);
  const series=getHistorySeries();
  const kind=$('histKind')?.value || 'datalogger';

  // table
  const tbody=q('#tblHist tbody');
  const rows = series.slice().reverse().slice(0,2000).map(r=>{
    // Mantemos a grelha estável para os 3 tipos (DL/C/Meteo)
    const lvl = (r.level_pct===null || r.level_pct===undefined) ? '—' : escapeHtml(String(r.level_pct));
    const flow = (r.flow_lps===null || r.flow_lps===undefined) ? '—' : escapeHtml(String(r.flow_lps));
    const flowTot = (r.flow_total_m3===null || r.flow_total_m3===undefined) ? '—' : escapeHtml(String(r.flow_total_m3));
    const p = (r.p_mm_h===null || r.p_mm_h===undefined) ? '—' : escapeHtml(String(r.p_mm_h));
    const pTot = (r.p_total_mm===null || r.p_total_mm===undefined) ? '—' : escapeHtml(String(r.p_total_mm));
    const delBtn = isAdmin()? `<button class="btn danger" data-hdel="${escapeHtml(String(r.t))}">Eliminar</button>` : '';
    return `      <tr>        <td>${escapeHtml(String(r.t))}</td>        <td>${lvl}</td>        <td>${flow}</td>        <td>${flowTot}</td>        <td>${p}</td>        <td>${pTot}</td>        <td>${delBtn}</td>      </tr>    `;
  }).join('');
  tbody.innerHTML = rows || `<tr><td colspan="7" class="muted small">Sem dados.</td></tr>`;

  // chart (render em frame seguinte para evitar canvas com largura 0 quando o separador acabou de mudar)
  requestAnimationFrame(()=> drawChart(series));
}

function drawChart(series){
  const canvas=$("histChart");
  if(!canvas) return;
  const ctx=canvas.getContext("2d");
  const dpr=window.devicePixelRatio||1;
  const w=canvas.width = Math.max(320,(canvas.parentElement?.clientWidth||600)-4)*dpr;
  const h=canvas.height = (Number(canvas.getAttribute("height"))||180)*dpr;
  ctx.clearRect(0,0,w,h);

  if(!series || series.length<1){
    ctx.fillStyle="rgba(2,6,23,.7)";
    ctx.fillText("Sem dados suficientes para gráfico.", 12*dpr, 24*dpr);
    return;
  }

  const kind=$("histKind")?.value || "datalogger";
  let vals = series.map(p=> (kind==="meteo" ? Number(p.p_mm_h??0) : Number(p.level_pct??0)));
  if(kind!=="meteo" && vals.every(v=>!isFinite(v))) vals = series.map(p=>Number(p.flow_lps??0));
  let vMin=Math.min(...vals), vMax=Math.max(...vals);
  if(kind==="meteo"){ vMin=0; vMax=500; }

  const padL=54*dpr, padR=14*dpr, padT=12*dpr, padB=28*dpr;
  const iw=w-padL-padR, ih=h-padT-padB;
  const xAt=(i)=> padL + iw*(i/(series.length-1));
  const scale=(v,min,max)=> (max===min)?0.5:((v-min)/(max-min));
  const yAt=(v)=> padT + ih*(1-scale(v,vMin,vMax));

  // grid + left axis
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
    const v = vMax - (vMax-vMin)*(i/4);
    const y = padT + ih*(i/4);
    const txt = isFinite(v) ? v.toFixed(1) : "—";
    ctx.fillText(txt, 6*dpr, y+4*dpr);
  }

  // line
  ctx.strokeStyle="rgba(212,175,55,.95)";
  ctx.lineWidth=2*dpr;
  ctx.beginPath();
  for(let i=0;i<series.length;i++){
    const x=xAt(i), y=yAt(vals[i]);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // legend (with color key)
  const lbl = (kind==="meteo") ? "Precipitação (mm/h)" : "Série temporal";
  const sw = 10*dpr, sh = 10*dpr;
  ctx.fillStyle = "rgba(212,175,55,.95)";
  ctx.fillRect(padL, 6*dpr, sw, sh);
  ctx.fillStyle = "rgba(2,6,23,.82)";
  ctx.font = `${12*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
  ctx.fillText(lbl, padL + sw + 6*dpr, 14*dpr);
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
    renderHistorico();
  });
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
    level: clamp(Number($("cfgAlertLevel").value||90),0,100),
    email: $("cfgAlertEmail").checked,
    sms: $("cfgAlertSMS").checked
  };
  setCfg(cfg);
  audit("CFG_SAVE","alerts");
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

/* ---------- Clock ---------- */
function startClock(){
  const tick=()=>{
    const now=new Date();
    $("nowClock").textContent = now.toLocaleString("pt-PT");
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------- SCADA “add” stubs ---------- */
function openScadaStub(kind){
  openModal("SCADA — ligação futura", `
    <div class="panel">
      <div class="muted small">Esta aplicação está preparada para ligar a um servidor SCADA externo. Quando existir API, basta enviar updates para:</div>
      <div class="panel" style="margin-top:10px">
        <div class="muted small"><code>applyScadaUpdate("${kind}", { device_id: "...", timestamp: "...", level_pct: 75, flow_lps: 120.5 })</code></div>
      </div>
      <div class="muted small" style="margin-top:10px">Também é possível implementar WebSocket/HTTP polling para atualizações em tempo real.</div>
    </div>
  `);
  audit("SCADA_STUB", kind);
}

/* ---------- Boot app ---------- */
function bootApp(){
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
  // eye-delegation v39 (single handler)
  document.addEventListener('click', (e)=>{
    const btn = e.target && e.target.closest ? e.target.closest('[data-eye]') : null;
    if(!btn) return;
    const id = btn.getAttribute('data-eye');
    const input = document.getElementById(id);
    if(!input) return;
    input.type = (input.type === 'password') ? 'text' : 'password';
    btn.textContent = (input.type === 'password') ? '👁' : '🙈';
  });


  // dashboard search filters
  $("qDL").addEventListener("input", renderQuickLists);
  $("qC").addEventListener("input", renderQuickLists);

  // weather
  populateCities();
  $("btnWeatherSet").onclick = async ()=>{
    const name=($("weatherCity").value||"").trim();
    if(!name) return;
    try{
      const loc=await geocodeCityPT(name);
      const cfg=getCfg();
      cfg.weatherLocation=loc;
      setCfg(cfg);
      audit("WEATHER_CITY", loc.name);
      await loadWeather();
  renderMeteoSource();
  updateMeteoForAllLocalities();
    }catch(e){
      $("weatherMeta").textContent = "Não foi possível obter a cidade (verifica ligação à internet).";
    }
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

  $("btnDLScada").onclick=()=>openScadaStub("datalogger");
  $("btnCScada").onclick=()=>openScadaStub("caudal");

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

  // historico
  $("histKind").onchange=()=>{ histDeviceOptions(false); renderHistorico(); };
  $("histDevice").onchange=renderHistorico;
  $("histAgg").onchange=renderHistorico;
  $("histRange").onchange=renderHistorico;
  $("btnHistRefresh").onclick=renderHistorico;
  $("btnExportCSV").onclick=exportHistoricoCSV;
  $("btnExportPDF").onclick=exportPDF;
  if($("btnExportXLS")) $("btnExportXLS").onclick=exportHistoricoExcel;
  if($("histDate")) $("histDate").onchange=renderHistorico;
  $("btnHistDelete").onclick=deleteHistorico;

  // audit
  $("btnAuditExport").onclick=exportAuditCSV;
  $("btnAuditClear").onclick=clearAudit;

  // init map + data
  ensureBootstrap();
  refreshHeader();
  try{ applyNavPerms(); }catch(e){}
  initMap();
  renderDashboard();
  renderDLTable();
  renderCTable();
  renderUsers();
  renderConfig();
  renderAudit();
  histDeviceOptions(false);
  renderHistorico();

  // initial weather
  loadWeather().catch(()=>{
    $("weatherMeta").textContent = "Sem ligação ao servidor meteorológico.";
  });

  // start simulated history recording each minute
  if(simTimer) clearInterval(simTimer);
  simTimer = setInterval(tickSimulateHistory, 60_000);

  // also seed one tick now so history isn't empty
  tickSimulateHistory();

  // default tab
  showTab("dashboard");
}

/* ---------- Start ---------- */
window.addEventListener("DOMContentLoaded", ()=>{
  ensureBootstrap();
  // restore session if exists
  const sess = load(LS.session, {email:null});
  const logged = !!sess.email;
  setAuthUI(logged);
  refreshHeader();
  try{ applyNavPerms(); }catch(e){}
  wireEyes();
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

  // Larger axis label area for readability (requested: big numbers)
  const padL = 66*dpr, padR = 66*dpr, padT = 12*dpr, padB = 30*dpr;
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
  ctx.font = `${14*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;

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

  // legend
  // Legend with color keys (requested: legends in all charts)
  const lgFont = 12*dpr;
  ctx.font = `${lgFont}px system-ui, -apple-system, Segoe UI, Roboto`;
  const lx = padL;
  const ly1 = 14*dpr;
  const ly2 = 30*dpr;
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
  const h = getHist();
  const key = kind==="datalogger" ? "dl" : "c";
  const arr = (h[key] && h[key][id]) ? h[key][id] : [];
  return arr.map(p=>({ t:p.t, level_pct:p.level_pct, flow_lps:p.flow_lps })).slice(-180);
}

function renderDeviceChart(kind, id){
  const series = getDeviceSeries(kind, id);
  const canvas = $("devChart");
  if(!canvas) return;
  if(series.length<2){
    const ctx=canvas.getContext("2d");
    const w=canvas.width = canvas.parentElement.clientWidth - 4;
    ctx.clearRect(0,0,w,canvas.height);
    ctx.fillText("Sem dados suficientes.", 12, 24);
    return;
  }
  const st = drawCombo(canvas, series, { barKey:"flow_lps", lineKey:"level_pct", barLabel:"Caudal (m³)", lineLabel:"Nível (%)" });
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
  _dashSel = { kind, id, name };
  if($("dashSelLabel")) $("dashSelLabel").textContent = name ? name : "—";
  renderDashboardDeviceChart(kind, id);
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
  drawCombo(canvas, series, { barKey:"flow_lps", lineKey:"level_pct", barLabel:"Caudal (m³)", lineLabel:"Nível (%)" });

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
  ctx.font = `${12*dpr}px system-ui, -apple-system, Segoe UI, Roboto`;
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

function bindEyeToggles(){
  qa("button.eye[data-eye]").forEach(btn=>{
    btn.onclick=()=>{
      const targetId=btn.getAttribute("data-eye");
      const inp=$(targetId);
      if(!inp) return;
      const isPwd = inp.getAttribute("type")==="password";
      inp.setAttribute("type", isPwd ? "text" : "password");
      btn.classList.toggle("on", isPwd);
    };
  });
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

document.addEventListener('DOMContentLoaded', ()=>{ try{ bindEyeToggles(); }catch(e){} });

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
