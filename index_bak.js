/* Modern WLED Master UI (drop-in replacement)
   - Node discovery via THIS device /json/nodes
   - Group controls + preset aggregation by name
   - All vanilla; no external fonts; inline SVG icons in HTML
*/
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
let logEl = null;
const nodeCountChip = $("#chip-node-count");
const nodesWrap = $("#nodes");
const originHost = location.host;
const nodesEndpoint = `http://${originHost}/json/nodes`;

// Simple hash router for mobile tabs
const routes = ["nodes", "controls", "celebrate", "presets", "logs"];
function setActiveRoute(route) {
  routes.forEach((r) => {
    const v = document.getElementById(`view-${r}`);
    const t = document.querySelector(`.tabs [data-route="${r}"]`);
    if (v) {
      if (r === route) v.classList.add("active");
      else v.classList.remove("active");
    }
    if (t) {
      if (r === route) t.classList.add("active");
      else t.classList.remove("active");
    }
  });
}
function readRoute() {
  const h = (location.hash || "").replace("#", "");
  return routes.includes(h) ? h : "nodes";
}
function navigate(route) {
  location.hash = `#${route}`;
}
window.addEventListener("hashchange", () => setActiveRoute(readRoute()));

const store = {
  saveNodes(nodes) {
    localStorage.setItem("wled_master_nodes", JSON.stringify(nodes));
  },
  loadNodes() {
    try {
      return JSON.parse(localStorage.getItem("wled_master_nodes") || "[]");
    } catch {
      return [];
    }
  },
  saveGlobals(globals) {
    localStorage.setItem("wled_master_globals", JSON.stringify(globals));
  },
  loadGlobals() {
    try {
      return JSON.parse(localStorage.getItem("wled_master_globals") || "[]");
    } catch {
      return [];
    }
  },
};

const state = {
  nodes: [], // {ip, name, leds, ver, checked, presets: Map(name -> [{id, ip}])}
  autoTimer: null,
  presetFilterIps: new Set(),
  presetSearch: "",
};

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  if (!logEl) logEl = document.querySelector("#log");
  if (logEl) {
    logEl.textContent += `[${ts}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }
}

async function fetchT(url, opts = {}, ms = 2000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

function normNode(e) {
  let ip = e.ip || e.ipv4 || e.address || "";
  if (Array.isArray(ip)) ip = ip.join(".");
  if (typeof ip !== "string") ip = String(ip || "");
  const name = e.name || e.nn || e.id || ip;
  return { ip, name };
}

async function refreshNodes() {
  try {
    const res = await fetchT(nodesEndpoint, {}, 2500);
    if (!res.ok) throw new Error(`/json/nodes HTTP ${res.status}`);
    const j = await res.json();
    const arr = Array.isArray(j) ? j : Array.isArray(j.nodes) ? j.nodes : [];
    const prev = new Map(state.nodes.map((n) => [n.ip, n]));
    state.nodes = arr.map((e) => {
      const { ip, name } = normNode(e);
      const existed = prev.get(ip);
      return {
        ip,
        name,
        leds: existed?.leds ?? 0,
        ver: existed?.ver ?? "–",
        checked: existed?.checked ?? true,
        presets: existed?.presets ?? null,
      };
    });
    renderNodes();
    nodeCountChip.textContent = String(state.nodes.length);
    log(`Discovered ${state.nodes.length} node(s).`);
  } catch (e) {
    log(`Nodes refresh failed: ${e.message}`);
  }
}

async function getInfo(ip) {
  const res = await fetchT(`http://${ip}/json/info`);
  if (!res.ok) throw new Error(`info ${ip} HTTP ${res.status}`);
  const j = await res.json();
  return {
    name: j.name || ip,
    leds: j.leds?.count ?? j.leds?.num ?? 0,
    ver: j.ver || j.version || "unknown",
  };
}

async function getPresets(ip) {
  const res = await fetchT(`http://${ip}/presets.json`, {}, 2500);
  if (!res.ok) throw new Error(`presets ${ip} HTTP ${res.status}`);
  const j = await res.json();
  const out = [];
  for (const [id, obj] of Object.entries(j)) {
    const pid = parseInt(id, 10);
    if (!isFinite(pid)) continue;
    const name =
      obj && (obj.n || obj.name) ? obj.n || obj.name : `Preset ${pid}`;
    // Try to extract representative colors
    let col = null;
    if (obj && typeof obj === "object") {
      if (Array.isArray(obj.col)) col = obj.col;
      else if (
        Array.isArray(obj.seg) &&
        obj.seg[0] &&
        Array.isArray(obj.seg[0].col)
      )
        col = obj.seg[0].col;
    }
    out.push({ id: pid, name, col });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function postState(ip, body) {
  const res = await fetchT(`http://${ip}/json/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`state ${ip} HTTP ${res.status}`);
  return res.json();
}

function renderNodes() {
  nodesWrap.innerHTML = "";
  for (const n of state.nodes) {
    const el = document.createElement("div");
    el.className = "node";
    el.setAttribute("data-ip", n.ip);
    el.innerHTML = `
      <div class="left">
        <div>
          <div class="name">${escapeHtml(n.name)} <span class="meta">(${
      n.ip
    })</span></div>
          <div class="meta">${n.leds} LEDs • v${n.ver}</div>
        </div>
      </div>
      <div>
        <span class="badge ${n.presets ? "ok" : "warn"}">${
      n.presets ? n.presets.size + " names" : "no presets"
    }</span>
      </div>
    `;
    el.classList.toggle("selected", !!n.checked);
    el.classList.toggle("not-selected", !n.checked);
    el.addEventListener("click", () => {
      n.checked = !n.checked;
      el.classList.toggle("selected", n.checked);
      el.classList.toggle("not-selected", !n.checked);
    });
    nodesWrap.appendChild(el);
  }
  // selection now toggled by clicking the node card
}

async function refreshSelected() {
  const sel = state.nodes.filter((n) => n.checked);
  if (!sel.length) {
    log("No nodes selected.");
    return;
  }
  for (const n of sel) {
    try {
      const info = await getInfo(n.ip);
      n.name = info.name;
      n.leds = info.leds;
      n.ver = info.ver;
      try {
        const pres = await getPresets(n.ip);
        const pm = new Map();
        for (const p of pres) {
          const arr = pm.get(p.name) || [];
          arr.push({ id: p.id, ip: n.ip, col: p.col });
          pm.set(p.name, arr);
        }
        n.presets = pm;
        log(`Refreshed ${n.ip}: ${pres.length} presets.`);
      } catch (e) {
        n.presets = null;
        log(`Presets ${n.ip}: ${e.message}`);
      }
    } catch (e) {
      log(`Info ${n.ip}: ${e.message}`);
    }
  }
  renderNodes();
  // Auto-hydrate presets grid after fetching presets
  const modeEl = document.querySelector('input[name="presetMode"]:checked');
  const mode = modeEl ? modeEl.value : "union";
  renderPresets(mode);
  renderPresetDeviceChips();
}

function aggPresets(mode = "union") {
  const sel = state.nodes.filter((n) => n.checked && n.presets instanceof Map);
  const out = new Map();
  if (!sel.length) return out;
  if (mode === "common") {
    const first = sel[0].presets;
    for (const name of first.keys()) {
      let all = true;
      const refs = [];
      for (const n of sel) {
        const arr = n.presets.get(name);
        if (!arr) {
          all = false;
          break;
        }
        refs.push(...arr);
      }
      if (all) out.set(name, refs);
    }
  } else {
    for (const n of sel) {
      for (const [name, refs] of n.presets.entries()) {
        const cur = out.get(name) || [];
        out.set(name, cur.concat(refs));
      }
    }
  }
  return out;
}

function renderPresets(mode = "union") {
  const contEl = $("#presets");
  contEl.innerHTML = "";
  const agg = aggPresets(mode);
  const names = Array.from(agg.keys()).sort((a, b) => a.localeCompare(b));
  // apply search filter
  const term = (state.presetSearch || "").toLowerCase();
  const filteredNames = names.filter(
    (n) => !term || n.toLowerCase().includes(term)
  );
  if (!names.length) {
    contEl.innerHTML =
      '<div class="hint">No presets loaded. Click “Load from Selected”.</div>';
    return;
  }
  for (const name of filteredNames) {
    const el = document.createElement("div");
    el.className = "preset";
    const refs = agg.get(name);
    // device filter: keep if any ref ip is in selected set (or no filters)
    const refIps = new Set(refs.map((r) => r.ip));
    const hasFilter = state.presetFilterIps && state.presetFilterIps.size > 0;
    if (hasFilter) {
      let match = false;
      for (const ip of refIps) {
        if (state.presetFilterIps.has(ip)) {
          match = true;
          break;
        }
      }
      if (!match) continue;
    }
    // Pick the first ref to derive colors preview (same preset id on different nodes typically shares colors)
    let previewCol = null;
    if (refs && refs.length) {
      const firstRef = refs[0];
      const node = state.nodes.find((n) => n.ip === firstRef.ip);
      // Find this preset id on that node again to access stored colors if present
      // We only stored colors when fetching per-node presets; refs only has id/ip
      if (node && node.presets) {
        // node.presets is Map(name -> array of {id, ip}) we don't have color there.
        // So we will fall back to coloring later based on name lookup in a separate cache if available in future.
      }
    }
    const ips = Array.from(new Set(refs.map((r) => r.ip)));
    const ipToName = new Map(state.nodes.map((n) => [n.ip, n.name]));
    const devHtml = ips
      .map(
        (ip) =>
          `<span class=\"dev-chip\" title=\"${ip}\">${escapeHtml(
            ipToName.get(ip) || ip
          )}</span>`
      )
      .join(" ");
    // derive colors from first ref that has col
    const firstWithCol = refs.find((r) => Array.isArray(r.col));
    if (firstWithCol && Array.isArray(firstWithCol.col)) {
      const c = firstWithCol.col; // array of RGB arrays e.g., [[r,g,b],[...]]
      const c1 = Array.isArray(c[0])
        ? `rgb(${c[0][0]},${c[0][1]},${c[0][2]})`
        : null;
      const c2 = Array.isArray(c[1])
        ? `rgb(${c[1][0]},${c[1][1]},${c[1][2]})`
        : null;
      const c3 = Array.isArray(c[2])
        ? `rgb(${c[2][0]},${c[2][1]},${c[2][2]})`
        : null;
      const stops = [c1, c2, c3].filter(Boolean);
      if (stops.length) {
        el.style.background =
          stops.length === 1
            ? stops[0]
            : `linear-gradient(90deg, ${stops.join(", ")})`;
      }
    }
    el.innerHTML = `
      <div class="title">${escapeHtml(name)}</div>
      <div class="row">
        <div class="devs">${devHtml}</div>
        <span class="src">${refs.length} refs</span>
      </div>`;
    // background preview via CSS custom props if we can fetch one representative preset's colors later
    // We will attach colors once clicked/loaded if needed in future.
    el.setAttribute("data-apply", encodeURIComponent(name));
    el.tabIndex = 0;
    el.addEventListener("click", async () => {
      el.classList.add("selected");
      try {
        await applyPresetByName(name);
      } finally {
        setTimeout(() => el.classList.remove("selected"), 700);
      }
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        el.click();
      }
    });
    contEl.appendChild(el);
  }
}

function renderPresetDeviceChips() {
  const devFilters = document.getElementById("preset-device-filters");
  if (!devFilters) return;
  devFilters.innerHTML = "";
  const ips = Array.from(
    new Set(
      state.nodes.filter((n) => n.presets instanceof Map).map((n) => n.ip)
    )
  );
  const ipToName = new Map(state.nodes.map((n) => [n.ip, n.name]));
  for (const ip of ips) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = ipToName.get(ip) || ip;
    b.title = ip;
    b.classList.toggle("selected", state.presetFilterIps.has(ip));
    b.addEventListener("click", () => {
      if (state.presetFilterIps.has(ip)) state.presetFilterIps.delete(ip);
      else state.presetFilterIps.add(ip);
      renderPresetDeviceChips();
      const mode =
        document.querySelector('input[name="presetMode"]:checked')?.value ||
        "union";
      renderPresets(mode);
    });
    devFilters.appendChild(b);
  }
}

async function applyPresetByName(name) {
  const sel = state.nodes.filter((n) => n.checked && n.presets instanceof Map);
  if (!sel.length) {
    log("No nodes selected.");
    return;
  }
  await Promise.all(
    sel.map(async (n) => {
      const arr = n.presets.get(name);
      if (!arr || !arr.length) return;
      const pid = arr[0].id;
      try {
        await postState(n.ip, { ps: pid });
        log(`Applied "${name}" on ${n.ip} (ps ${pid}).`);
        toast(`Preset "${name}" applied on ${n.name || n.ip}.`, "ok", 1800);
      } catch (e) {
        log(`Apply preset on ${n.ip} failed: ${e.message}`);
      }
    })
  );
}

async function broadcastState(body) {
  const sel = state.nodes.filter((n) => n.checked);
  if (!sel.length) {
    log("No nodes selected.");
    return;
  }
  toast(`Sending to ${sel.length} device(s)…`, "ok", 1500);
  await Promise.all(
    sel.map(async (n) => {
      try {
        await postState(n.ip, body);
      } catch (e) {
        log(`POST ${n.ip} failed: ${e.message}`);
      }
    })
  );
  log("Broadcast complete.");
  toast("Broadcast complete.", "ok", 1600);
}

// Global snapshots (local only)
async function readState(ip) {
  const res = await fetchT(`http://${ip}/json/state`);
  if (!res.ok) throw new Error(`read state ${ip} HTTP ${res.status}`);
  return res.json();
}

async function saveGlobal(name) {
  name = (name || "").trim();
  if (!name) {
    log("Enter a name for the global preset.");
    return;
  }
  const sel = state.nodes.filter((n) => n.checked);
  if (!sel.length) {
    log("No nodes selected.");
    return;
  }
  const globals = store.loadGlobals();
  const snapshot = [];
  for (const n of sel) {
    try {
      const st = await readState(n.ip);
      snapshot.push({ ip: n.ip, state: st });
    } catch (e) {
      log(`Snapshot ${n.ip} failed: ${e.message}`);
    }
  }
  globals.push({ name, created: Date.now(), devices: snapshot });
  store.saveGlobals(globals);
  log(`Saved global "${name}" with ${snapshot.length} devices.`);
}

async function pushGlobal(name) {
  const globals = store.loadGlobals();
  const g = globals.find((x) => x.name === name) || globals[globals.length - 1];
  if (!g) {
    log("No global to push.");
    return;
  }
  const target = state.nodes.filter((n) => n.checked);
  if (!target.length) {
    log("No nodes selected.");
    return;
  }
  for (const t of target) {
    const snap = g.devices.find((d) => d.ip === t.ip) || g.devices[0];
    if (!snap) continue;
    try {
      await postState(t.ip, snap.state);
      log(`Pushed global "${g.name}" to ${t.ip}.`);
    } catch (e) {
      log(`Push to ${t.ip} failed: ${e.message}`);
    }
  }
}

// Celebrate: send an effect to all selected nodes using per-device LED COUNT as stop,
// then restore prior state after duration.
let _celeRestore = null;
async function celebrateRun() {
  const sel = state.nodes.filter((n) => n.checked);
  if (!sel.length) {
    log("No nodes selected.");
    return;
  }
  const color1 = hexToRgb($("#cele-c1").value);
  const color2 = hexToRgb($("#cele-c2").value);
  const fx = parseInt($("#cele-fx").value, 10) || 0;
  const sx = parseInt($("#cele-sx").value, 10) || 200;
  const ix = parseInt($("#cele-ix").value, 10) || 180;
  const bri = parseInt($("#cele-bri").value, 10) || 255;
  const durMs = Math.max(1, parseInt($("#cele-dur").value, 10) || 30) * 1000;

  // snapshot states
  _celeRestore = [];
  for (const n of sel) {
    try {
      // Ensure leds is known
      if (!n.leds || n.leds <= 0) {
        const info = await getInfo(n.ip);
        n.leds = info.leds || n.leds || 0;
      }
      const st = await readState(n.ip);
      _celeRestore.push({ ip: n.ip, state: st });
    } catch (e) {
      log(`Snapshot ${n.ip} failed: ${e.message}`);
    }
  }

  // broadcast celebration
  toast(`Celebration sending to ${sel.length}…`, "ok", 1500);
  await Promise.all(
    sel.map(async (n) => {
      const stop = Math.max(1, n.leds | 0);
      const body = {
        on: true,
        bri,
        transition: 0,
        seg: [
          {
            id: 0,
            start: 0,
            stop: stop,
            fx,
            sx,
            ix,
            col: [color1, color2, [0, 0, 0]],
          },
        ],
      };
      try {
        await postState(n.ip, body);
      } catch (e) {
        log(`Celebrate post ${n.ip} failed: ${e.message}`);
      }
    })
  );
  log(`Celebration sent to ${sel.length} node(s) for ${durMs / 1000}s.`);
  toast("Celebration broadcast complete.", "ok", 1800);

  // schedule restore
  if (_celeRestoreTimer) clearTimeout(_celeRestoreTimer);
  _celeRestoreTimer = setTimeout(celebrateRestore, durMs);
}

let _celeRestoreTimer = null;
async function celebrateRestore() {
  if (!_celeRestore || !_celeRestore.length) {
    log("No saved celebration state to restore.");
    return;
  }
  const arr = _celeRestore.slice();
  _celeRestore = null;
  if (_celeRestoreTimer) {
    clearTimeout(_celeRestoreTimer);
    _celeRestoreTimer = null;
  }
  await Promise.all(
    arr.map(async (d) => {
      try {
        await postState(d.ip, d.state);
      } catch (e) {
        log(`Restore ${d.ip} failed: ${e.message}`);
      }
    })
  );
  log("Celebration restored previous state.");
}

// UI wire-up
function init() {
  $("#btn-refresh-nodes").addEventListener("click", refreshNodes);
  $("#btn-select-all").addEventListener("click", () => {
    state.nodes.forEach((n) => (n.checked = true));
    renderNodes();
  });
  $("#btn-clear-sel").addEventListener("click", () => {
    state.nodes.forEach((n) => (n.checked = false));
    renderNodes();
  });
  $("#btn-refresh").addEventListener("click", refreshSelected);

  $("#btn-load-presets").addEventListener("click", async () => {
    await refreshSelected();
    const mode = document.querySelector(
      'input[name="presetMode"]:checked'
    ).value;
    renderPresets(mode);
    renderPresetDeviceChips();
  });
  $$('input[name="presetMode"]').forEach((r) =>
    r.addEventListener("change", () => {
      const mode = document.querySelector(
        'input[name="presetMode"]:checked'
      ).value;
      renderPresets(mode);
      renderPresetDeviceChips();
    })
  );
  const searchInput = document.getElementById("preset-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      state.presetSearch = searchInput.value || "";
      const mode =
        document.querySelector('input[name="presetMode"]:checked')?.value ||
        "union";
      renderPresets(mode);
    });
  }

  // group
  document
    .querySelector('[data-action="power-on"]')
    .addEventListener("click", () => broadcastState({ on: true }));
  document
    .querySelector('[data-action="power-off"]')
    .addEventListener("click", () => broadcastState({ on: false }));
  const bri = $("#range-bri"),
    briLbl = $("#label-bri");
  bri.addEventListener("input", () => (briLbl.textContent = bri.value));
  bri.addEventListener("change", () =>
    broadcastState({ bri: parseInt(bri.value, 10) })
  );
  $("#btn-apply-colors").addEventListener("click", () => {
    const c1 = hexToRgb($("#color1").value);
    const c2 = hexToRgb($("#color2").value);
    const c3 = hexToRgb($("#color3").value);
    broadcastState({ seg: [{ id: 0, col: [c1, c2, c3] }] });
  });
  $("#btn-apply-effect").addEventListener("click", () => {
    const fx = parseInt($("#effect-id").value, 10) || 0;
    const sx = parseInt($("#effect-sx").value, 10) || 128;
    const ix = parseInt($("#effect-ix").value, 10) || 128;
    const tr = parseInt($("#num-tr").value, 10) || 0;
    broadcastState({ transition: tr, seg: [{ id: 0, fx, sx, ix }] });
  });

  // globals
  $("#btn-save-global").addEventListener("click", () =>
    saveGlobal($("#new-preset-name").value)
  );
  $("#btn-push-preset").addEventListener("click", () =>
    pushGlobal($("#new-preset-name").value)
  );
  $("#btn-export-global").addEventListener("click", () => {
    const data = JSON.stringify(store.loadGlobals(), null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wled-master-globals.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  $("#file-import").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arr = JSON.parse(reader.result);
        store.saveGlobals(arr);
        log(`Imported ${Array.isArray(arr) ? arr.length : 0} global presets.`);
      } catch (err) {
        log("Import failed: " + err.message);
      }
    };
    reader.readAsText(f);
  });

  // celebrate buttons
  $("#btn-celebrate").addEventListener("click", celebrateRun);
  $("#btn-restore-now").addEventListener("click", celebrateRestore);

  // start
  setActiveRoute(readRoute());
  $$(".tabs .tab").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const r = a.getAttribute("data-route");
      navigate(r);
    })
  );
  refreshNodes();
  const autoBtn = document.getElementById("auto-refresh");
  // default on to match previous behavior
  autoBtn.classList.toggle("selected", true);
  autoBtn.classList.toggle("not-selected", false);
  const applyAutoState = (on) => {
    if (state.autoTimer) {
      clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
    if (on) state.autoTimer = setInterval(refreshNodes, 15000);
    autoBtn.classList.toggle("selected", !!on);
    autoBtn.classList.toggle("not-selected", !on);
  };
  let autoOn = true;
  applyAutoState(autoOn);
  autoBtn.addEventListener("click", () => {
    autoOn = !autoOn;
    applyAutoState(autoOn);
  });
}

// Helpers
function hexToRgb(hex) {
  const m = hex.replace("#", "");
  const n = parseInt(m, 16);
  if (m.length === 6) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  if (m.length === 3)
    return [((n >> 8) & 15) * 17, ((n >> 4) & 15) * 17, (n & 15) * 17];
  return [255, 255, 255];
}
function escapeHtml(s) {
  return (s ?? "").replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        m
      ])
  );
}

window.addEventListener("DOMContentLoaded", init);
// Toasts
function toast(message, type = "ok", timeout = 2500) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="msg">${escapeHtml(
    String(message)
  )}</div><button class="close" aria-label="Close">✕</button>`;
  const remove = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  el.querySelector(".close").addEventListener("click", remove);
  host.appendChild(el);
  if (timeout > 0) setTimeout(remove, timeout);
}
