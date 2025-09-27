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
  presetHydratedOnce: false,
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
        on: existed?.on ?? false,
      };
    });
    renderNodes();
    const chip = document.getElementById("chip-node-count");
    if (chip) chip.textContent = String(state.nodes.length);
    log(`Discovered ${state.nodes.length} node(s).`);
    // After initial node discovery, hydrate presets automatically once
    if (!state.presetHydratedOnce && state.nodes.length) {
      state.presetHydratedOnce = true;
      await refreshSelected();
      const mode =
        document.querySelector('input[name="presetMode"]:checked')?.value ||
        "union";
      renderPresets(mode);
      renderPresetDeviceChips();
    }
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
    on: !!(j && j.state && j.state.on),
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
    out.push({ id: pid, name, col, raw: obj });
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
  const wrap = document.getElementById("nodes");
  if (!wrap) return;
  wrap.innerHTML = "";
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
        <button class="btn tiny power ${n.on ? "good" : "warn"}" data-ip="${
      n.ip
    }" aria-label="Power ${
      n.on ? "on" : "off"
    }"><i class="fa-solid fa-power-off"></i></button>
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
    wrap.appendChild(el);
  }
  // selection now toggled by clicking the node card
  // wire per-node power buttons
  document.querySelectorAll(".btn.power[data-ip]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const ip = btn.getAttribute("data-ip");
      const node = state.nodes.find((n) => n.ip === ip);
      if (!node) return;
      const prev = !!node.on;
      const next = !prev;
      // optimistic UI
      node.on = next;
      btn.classList.toggle("good", next);
      btn.classList.toggle("warn", !next);
      btn.setAttribute("aria-label", `Power ${next ? "on" : "off"}`);
      btn.disabled = true;
      try {
        await postState(ip, { on: next });
        // recheck actual state
        try {
          const st = await readState(ip);
          const actual = !!(st && st.on);
          if (actual !== next) {
            // rollback
            node.on = actual;
            btn.classList.toggle("good", actual);
            btn.classList.toggle("warn", !actual);
            btn.setAttribute("aria-label", `Power ${actual ? "on" : "off"}`);
            toast(
              `Device ${node.name || ip} reported ${
                actual ? "on" : "off"
              } (rolled back)`,
              "warn",
              2200
            );
          } else {
            toast(
              `Power ${next ? "on" : "off"} for ${node.name || ip}`,
              "ok",
              1400
            );
          }
        } catch (e) {
          // if recheck fails, keep optimistic but notify
          toast(
            `Power toggled, verify state on ${node.name || ip}`,
            "warn",
            2000
          );
        }
      } catch (e) {
        // request failed: rollback
        node.on = prev;
        btn.classList.toggle("good", prev);
        btn.classList.toggle("warn", !prev);
        btn.setAttribute("aria-label", `Power ${prev ? "on" : "off"}`);
        toast(`Power toggle failed on ${node.name || ip}`, "warn", 1800);
      } finally {
        btn.disabled = false;
      }
    });
  });
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
      n.on = !!info.on;
      try {
        const pres = await getPresets(n.ip);
        const pm = new Map();
        for (const p of pres) {
          const arr = pm.get(p.name) || [];
          arr.push({ id: p.id, ip: n.ip, col: p.col, raw: p.raw });
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

function openPresetModal(presetName) {
  const modal = document.getElementById("preset-modal");
  const nameEl = document.getElementById("pm-preset-name");
  const list = document.getElementById("pm-devices");
  const btnAll = document.getElementById("pm-all");
  const btnNone = document.getElementById("pm-none");
  const btnClose = document.getElementById("pm-close");
  const btnApply = document.getElementById("pm-apply");
  if (
    !modal ||
    !nameEl ||
    !list ||
    !btnAll ||
    !btnNone ||
    !btnClose ||
    !btnApply
  )
    return false;
  nameEl.textContent = presetName;
  list.innerHTML = "";
  // List currently known nodes, selected by default == all devices
  const selectedSet = new Set(state.nodes.map((n) => n.ip));
  for (const n of state.nodes) {
    const row = document.createElement("div");
    row.className = "pm-item";
    if (selectedSet.has(n.ip)) row.classList.add("selected");
    row.setAttribute("data-ip", n.ip);
    row.innerHTML = `<div><div>${escapeHtml(n.name)} <span class=\"meta\">(${
      n.ip
    })</span></div><div class=\"meta\">v${n.ver} • ${n.leds} LEDs</div></div>`;
    row.addEventListener("click", () => {
      row.classList.toggle("selected");
    });
    list.appendChild(row);
  }
  btnAll.onclick = () => {
    list
      .querySelectorAll(".pm-item")
      .forEach((row) => row.classList.add("selected"));
  };
  btnNone.onclick = () => {
    list
      .querySelectorAll(".pm-item")
      .forEach((row) => row.classList.remove("selected"));
  };
  const close = () => {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  };
  btnClose.onclick = close;
  btnApply.onclick = async () => {
    const ips = Array.from(list.querySelectorAll(".pm-item.selected")).map(
      (r) => r.getAttribute("data-ip")
    );
    if (!ips.length) {
      toast("Select at least one device", "warn", 1600);
      return;
    }
    const prevSel = new Set(
      state.nodes.filter((n) => n.checked).map((n) => n.ip)
    );
    state.nodes.forEach((n) => (n.checked = ips.includes(n.ip)));
    try {
      await applyPresetStateToIps(presetName, ips);
    } finally {
      state.nodes.forEach((n) => (n.checked = prevSel.has(n.ip)));
    }
    close();
  };
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  return true;
}

function renderPresets(mode = "union") {
  const contEl = $("#presets");
  if (!contEl) return;
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
    // colors preview
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
    const firstWithCol = refs.find((r) => Array.isArray(r.col));
    if (firstWithCol && Array.isArray(firstWithCol.col)) {
      const c = firstWithCol.col;
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
    el.setAttribute("data-apply", encodeURIComponent(name));
    el.tabIndex = 0;
    el.addEventListener("click", async () => {
      // open modal, fallback to immediate apply if modal missing
      if (!openPresetModal(name)) {
        el.classList.add("selected");
        try {
          await applyPresetByName(name);
        } finally {
          setTimeout(() => el.classList.remove("selected"), 700);
        }
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
      if (state.presetFilterIps.has(ip)) {
        state.presetFilterIps.clear();
      } else {
        state.presetFilterIps.clear();
        state.presetFilterIps.add(ip);
      }
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

async function applyPresetStateToIps(presetName, ips) {
  const targets = state.nodes.filter((n) => ips.includes(n.ip));
  if (!targets.length) {
    toast("No devices selected", "warn", 1500);
    return;
  }
  let ok = 0,
    fail = 0;
  await Promise.all(
    targets.map(async (n) => {
      const refs = n.presets instanceof Map ? n.presets.get(presetName) : null;
      let body = null;
      if (refs && refs.length && refs[0].raw) {
        // Use raw preset content as state
        body =
          refs[0].raw && refs[0].raw.state ? refs[0].raw.state : refs[0].raw;
      }
      try {
        if (body) {
          await postState(n.ip, body);
          ok++;
        } else if (refs && refs.length) {
          await postState(n.ip, { ps: refs[0].id });
          ok++;
        } else {
          throw new Error("preset not present");
        }
      } catch (e) {
        fail++;
        log(`Apply preset to ${n.ip} failed: ${e.message}`);
      }
    })
  );
  if (fail) toast(`${ok} applied, ${fail} failed`, "warn", 2200);
  else toast("Preset applied to selected devices.", "ok", 1800);
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

// Celebrate: send effect to selected nodes then restore after duration
let _celeRestore = null;
let _celeRestoreTimer = null;
let _celeCountdownTimer = null;
function updateCelebratePreview() {
  const c1 = document.getElementById("cele-c1");
  const c2 = document.getElementById("cele-c2");
  const fx = document.getElementById("cele-fx");
  const sx = document.getElementById("cele-sx");
  const ix = document.getElementById("cele-ix");
  const bri = document.getElementById("cele-bri");
  const dur = document.getElementById("cele-dur");
  const sw = document.getElementById("cele-preview-swatches");
  const txt = document.getElementById("cele-preview-text");
  if (!sw || !txt || !c1 || !c2 || !fx || !sx || !ix || !bri || !dur) return;
  sw.innerHTML = "";
  const s1 = document.createElement("span");
  s1.style.width = "14px";
  s1.style.height = "14px";
  s1.style.borderRadius = "3px";
  s1.style.background = c1.value;
  sw.appendChild(s1);
  const s2 = document.createElement("span");
  s2.style.width = "14px";
  s2.style.height = "14px";
  s2.style.borderRadius = "3px";
  s2.style.background = c2.value;
  sw.appendChild(s2);
  txt.textContent = `FX ${fx.value} • S${sx.value} I${ix.value} • Bri ${bri.value} • ${dur.value}s`;
}
function showCelebrateStatus(show) {
  const bar = document.getElementById("cele-status");
  if (!bar) return;
  bar.style.display = show ? "flex" : "none";
}
function startCelebrateCountdown(ms) {
  const chip = document.getElementById("cele-countdown");
  if (!chip) return;
  let remain = Math.max(0, Math.floor(ms / 1000));
  chip.textContent = `${remain}s`;
  if (_celeCountdownTimer) clearInterval(_celeCountdownTimer);
  _celeCountdownTimer = setInterval(() => {
    remain -= 1;
    if (remain < 0) remain = 0;
    chip.textContent = `${remain}s`;
    if (remain === 0) {
      clearInterval(_celeCountdownTimer);
      _celeCountdownTimer = null;
    }
  }, 1000);
}
async function celebrateRun() {
  const sel = state.nodes.filter((n) => n.checked);
  if (!sel.length) {
    log("No nodes selected.");
    return;
  }
  const color1 = hexToRgb(document.getElementById("cele-c1").value);
  const color2 = hexToRgb(document.getElementById("cele-c2").value);
  const fx = parseInt(document.getElementById("cele-fx").value, 10) || 0;
  const sx = parseInt(document.getElementById("cele-sx").value, 10) || 200;
  const ix = parseInt(document.getElementById("cele-ix").value, 10) || 180;
  const bri = parseInt(document.getElementById("cele-bri").value, 10) || 255;
  const durMs =
    Math.max(1, parseInt(document.getElementById("cele-dur").value, 10) || 30) *
    1000;
  // snapshot states
  _celeRestore = [];
  for (const n of sel) {
    try {
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
  let ok = 0,
    fail = 0;
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
            stop,
            fx,
            sx,
            ix,
            col: [color1, color2, [0, 0, 0]],
          },
        ],
      };
      try {
        await postState(n.ip, body);
        ok++;
      } catch (e) {
        log(`Celebrate post ${n.ip} failed: ${e.message}`);
        fail++;
      }
    })
  );
  log(`Celebration sent to ${sel.length} node(s) for ${durMs / 1000}s.`);
  if (fail) toast(`${ok} sent, ${fail} failed`, "warn", 2200);
  else toast("Celebration broadcast complete.", "ok", 1800);
  showCelebrateStatus(true);
  startCelebrateCountdown(durMs);
  const cancelBtn = document.getElementById("cele-cancel");
  if (cancelBtn) {
    cancelBtn.disabled = false;
    const handler = async () => {
      cancelBtn.disabled = true;
      await celebrateRestore();
      showCelebrateStatus(false);
      if (_celeCountdownTimer) {
        clearInterval(_celeCountdownTimer);
        _celeCountdownTimer = null;
      }
      cancelBtn.removeEventListener("click", handler);
    };
    cancelBtn.addEventListener("click", handler);
  }
  if (_celeRestoreTimer) clearTimeout(_celeRestoreTimer);
  _celeRestoreTimer = setTimeout(async () => {
    await celebrateRestore();
    showCelebrateStatus(false);
    if (_celeCountdownTimer) {
      clearInterval(_celeCountdownTimer);
      _celeCountdownTimer = null;
    }
  }, durMs);
}
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
  let ok = 0,
    fail = 0;
  await Promise.all(
    arr.map(async (d) => {
      try {
        await postState(d.ip, d.state);
        ok++;
      } catch (e) {
        log(`Restore ${d.ip} failed: ${e.message}`);
        fail++;
      }
    })
  );
  if (fail) toast(`Restore done: ${ok} ok, ${fail} failed`, "warn", 2500);
  else toast("Celebration restored previous state.", "ok", 1800);
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

// Bootstrap: wire events and start discovery
window.addEventListener("DOMContentLoaded", () => {
  // route + tabs
  setActiveRoute(readRoute());
  document.querySelectorAll(".tabs .tab").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const r = a.getAttribute("data-route");
      navigate(r);
    })
  );

  // nodes toolbar
  const btnRefreshNodes = document.getElementById("btn-refresh-nodes");
  if (btnRefreshNodes) btnRefreshNodes.addEventListener("click", refreshNodes);
  const btnSelectAll = document.getElementById("btn-select-all");
  if (btnSelectAll)
    btnSelectAll.addEventListener("click", () => {
      state.nodes.forEach((n) => (n.checked = true));
      renderNodes();
    });
  const btnClearSel = document.getElementById("btn-clear-sel");
  if (btnClearSel)
    btnClearSel.addEventListener("click", () => {
      state.nodes.forEach((n) => (n.checked = false));
      renderNodes();
    });
  const btnRefreshSel = document.getElementById("btn-refresh");
  if (btnRefreshSel) btnRefreshSel.addEventListener("click", refreshSelected);

  // celebrate buttons
  const btnCele = document.getElementById("btn-celebrate");
  if (btnCele) btnCele.addEventListener("click", celebrateRun);
  const btnRestore = document.getElementById("btn-restore-now");
  if (btnRestore) btnRestore.addEventListener("click", celebrateRestore);
  [
    "cele-c1",
    "cele-c2",
    "cele-fx",
    "cele-sx",
    "cele-ix",
    "cele-bri",
    "cele-dur",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", updateCelebratePreview);
  });
  updateCelebratePreview();

  // presets wiring
  const btnLoadPresets = document.getElementById("btn-load-presets");
  if (btnLoadPresets)
    btnLoadPresets.addEventListener("click", async () => {
      await refreshSelected();
      const mode =
        document.querySelector('input[name="presetMode"]:checked')?.value ||
        "union";
      renderPresets(mode);
      renderPresetDeviceChips();
    });
  document.querySelectorAll('input[name="presetMode"]').forEach((r) =>
    r.addEventListener("change", () => {
      const mode =
        document.querySelector('input[name="presetMode"]:checked')?.value ||
        "union";
      renderPresets(mode);
      renderPresetDeviceChips();
    })
  );
  const searchInput = document.getElementById("preset-search");
  if (searchInput)
    searchInput.addEventListener("input", () => {
      state.presetSearch = searchInput.value || "";
      const mode =
        document.querySelector('input[name="presetMode"]:checked')?.value ||
        "union";
      renderPresets(mode);
    });

  // auto refresh toggle chip
  const autoBtn = document.getElementById("auto-refresh");
  const applyAutoState = (on) => {
    if (state.autoTimer) {
      clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
    if (on) state.autoTimer = setInterval(refreshNodes, 15000);
    if (autoBtn) {
      autoBtn.classList.toggle("selected", !!on);
      autoBtn.classList.toggle("not-selected", !on);
    }
  };
  let autoOn = true;
  if (autoBtn) {
    autoBtn.addEventListener("click", () => {
      autoOn = !autoOn;
      applyAutoState(autoOn);
    });
  }

  // initial discovery
  refreshNodes();
  applyAutoState(autoOn);
});
