// ─── Willow Dashboard — app.js ────────────────────────────────────────────────

const INDEXER_API    = "http://localhost:3001";
const CONTRACT_ADDR  = "0xb72a54bf4c5fe6e4448e7fd77dcc58c130141a3eba9eed2de7066fde3479aab3";
const APTOS_EXPLORER = "https://explorer.aptoslabs.com/account";
const NETWORK        = "testnet";

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  indexerOnline:   false,
  collections:     [],   // CollectionStatus[]
  logsPaused:      false,
  logCount:        0,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initGrid();
  initNav();
  initOverview();
  initCollections();
  initQuery();
  initAgents();
  initLogs();
  pingIndexer();
  setInterval(pingIndexer, 8000);
});

// ─── Animated grid background ─────────────────────────────────────────────────
function initGrid() {
  const canvas = $("gridCanvas");
  const ctx    = canvas.getContext("2d");
  let W, H;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener("resize", resize);

  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const step = 48;
    ctx.strokeStyle = "#1e3024";
    ctx.lineWidth   = 0.5;

    for (let x = 0; x < W; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Floating particles
    const t = frame * 0.003;
    for (let i = 0; i < 18; i++) {
      const seed  = i * 137.5;
      const x     = ((Math.sin(seed) * 0.5 + 0.5) * W + Math.sin(t + seed) * 40) % W;
      const y     = ((Math.cos(seed) * 0.5 + 0.5) * H + Math.cos(t * 0.7 + seed) * 30) % H;
      const alpha = (Math.sin(t * 1.3 + seed) * 0.3 + 0.4);
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(77, 255, 142, ${alpha})`;
      ctx.fill();
    }
    frame++;
    requestAnimationFrame(draw);
  }
  draw();
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function initNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("nav-item--active"));
      document.querySelectorAll(".view").forEach((v)  => v.classList.remove("view--active"));
      btn.classList.add("nav-item--active");
      document.getElementById(`view-${view}`)?.classList.add("view--active");
    });
  });
}

// ─── Indexer health ───────────────────────────────────────────────────────────
async function pingIndexer() {
  const dot  = $("indexerStatusDot");
  const text = $("indexerStatusText");
  try {
    const t0  = Date.now();
    const res = await fetch(`${INDEXER_API}/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("non-200");
    const data   = await res.json();
    const latency = Date.now() - t0;

    state.indexerOnline  = true;
    state.collections    = data;
    dot.className        = "status-dot status-dot--online";
    text.textContent     = `online · ${latency}ms`;
    $("statLatency").textContent = `${latency}ms`;

    refreshOverviewStats();
    log(`[indexer] ping ok — ${data.length} collection(s) tracked`, "ok");
  } catch {
    state.indexerOnline = false;
    dot.className       = "status-dot status-dot--offline";
    text.textContent    = "offline";
    $("statLatency").textContent = "—";
    log("[indexer] offline — is `npm start` running in willow-indexer/?", "warn");
  }
}

// ─── Overview ─────────────────────────────────────────────────────────────────
function initOverview() {
  $("contractAddrShort").textContent =
    CONTRACT_ADDR.slice(0, 6) + "…" + CONTRACT_ADDR.slice(-4);

  $("refreshStatus").addEventListener("click", () => {
    pingIndexer();
    toast("Refreshing…", "ok");
  });
}

function refreshOverviewStats() {
  const cols       = state.collections;
  const totalChunks = cols.reduce((s, c) => s + (c.indexedChunks || 0), 0);

  $("statCollections").textContent = cols.length;
  $("statChunks").textContent      = totalChunks.toLocaleString();

  const list = $("collectionStatusList");
  if (cols.length === 0) {
    list.innerHTML = `<div class="empty-state">No collections tracked yet.</div>`;
    return;
  }
  list.innerHTML = cols.map((c) => `
    <div class="col-status-item">
      <div>
        <div class="col-status-addr">${c.collectionAddr}</div>
      </div>
      <div class="col-status-meta">
        <span class="col-tag">${c.indexedChunks ?? 0} chunks</span>
        <span class="col-tag">${c.totalChunks ?? 0} total</span>
      </div>
    </div>
  `).join("");
}

// ─── Collections ──────────────────────────────────────────────────────────────
function initCollections() {
  // Track existing
  $("trackBtn").addEventListener("click", async () => {
    const addr = $("trackAddrInput").value.trim();
    if (!addr) { toast("Enter a collection address", "warn"); return; }
    try {
      const res = await fetch(`${INDEXER_API}/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectionAddr: addr }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      toast(`Tracking ${addr.slice(0,10)}…`, "ok");
      log(`[collections] tracking ${addr}`, "ok");
      await pingIndexer();
      renderCollectionCards();
    } catch (err) {
      toast(err.message, "error");
      log(`[collections] track error: ${err.message}`, "error");
    }
  });

  // Toggle create form
  $("toggleCreateForm").addEventListener("click", () => {
    const form = $("createCollectionForm");
    const open = form.style.display === "block";
    form.style.display = open ? "none" : "block";
    $("toggleCreateForm").textContent = open ? "+ Expand" : "− Collapse";
  });

  // Live preview CLI command
  ["colName","colModel","colDims","colMetric","colAccess"].forEach((id) => {
    $(id)?.addEventListener("input", updateCreatePreview);
  });

  $("createColBtn").addEventListener("click", () => {
    updateCreatePreview();
    toast("CLI command generated below ↓", "ok");
  });
}

function updateCreatePreview() {
  const name   = $("colName").value    || "my-rag-kb";
  const model  = $("colModel").value   || "text-embedding-3-small";
  const dims   = $("colDims").value    || "1536";
  const metric = $("colMetric").value  || "0";
  const access = $("colAccess").value  || "0";

  const cmd = `aptos move run \\
  --function-id '${CONTRACT_ADDR}::collection::create_collection' \\
  --args \\
    string:"${name}" \\
    string:"${model}" \\
    u64:${dims} \\
    u8:${metric} \\
    u8:${access} \\
  --profile shelbynet`;

  const preview = $("createCmdPreview");
  preview.textContent = cmd;
  preview.classList.add("visible");
}

function renderCollectionCards() {
  const container = $("collectionCards");
  if (state.collections.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = state.collections.map((c) => `
    <div class="col-card">
      <div class="col-card__addr">${c.collectionAddr}</div>
      <div class="col-card__name">${c.collectionAddr.slice(0, 12)}…</div>
      <div class="col-card__stats">
        <span class="col-stat">Indexed: <strong>${c.indexedChunks ?? 0}</strong></span>
        <span class="col-stat">Total: <strong>${c.totalChunks ?? 0}</strong></span>
        <span class="col-stat">Updated: <strong>${c.lastUpdated ? new Date(c.lastUpdated).toLocaleTimeString() : "—"}</strong></span>
      </div>
    </div>
  `).join("");
}

// ─── Vector Query ─────────────────────────────────────────────────────────────
function initQuery() {
  $("randomVecBtn").addEventListener("click", () => {
    const dims = 8;
    const vec  = Array.from({ length: dims }, () => parseFloat((Math.random() * 2 - 1).toFixed(4)));
    $("queryVector").value = JSON.stringify(vec);
    log(`[query] generated random ${dims}-dim test vector`, "info");
  });

  $("runQueryBtn").addEventListener("click", async () => {
    const addr   = $("queryAddr").value.trim();
    const k      = parseInt($("queryK").value) || 5;
    const rawVec = $("queryVector").value.trim();

    if (!addr)   { toast("Enter a collection address", "warn"); return; }
    if (!rawVec) { toast("Enter or generate a query vector", "warn"); return; }

    let vector;
    try { vector = JSON.parse(rawVec); }
    catch { toast("Invalid JSON vector", "error"); return; }

    if (!Array.isArray(vector)) { toast("Vector must be a JSON array", "error"); return; }

    try {
      $("runQueryBtn").textContent = "Querying…";
      $("runQueryBtn").disabled = true;

      const t0  = Date.now();
      const res = await fetch(`${INDEXER_API}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectionAddr: addr, vector, topK: k }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Query failed");

      const latency = Date.now() - t0;
      renderQueryResults(data.results ?? [], latency);
      log(`[query] ${data.results?.length ?? 0} results in ${latency}ms from ${addr.slice(0,10)}…`, "ok");
    } catch (err) {
      toast(err.message, "error");
      log(`[query] error: ${err.message}`, "error");
    } finally {
      $("runQueryBtn").textContent = "Run Query →";
      $("runQueryBtn").disabled = false;
    }
  });
}

function renderQueryResults(results, latencyMs) {
  const panel = $("queryResultPanel");
  const body  = $("queryResults");
  $("queryLatencyBadge").textContent = `${latencyMs}ms`;
  panel.style.display = "block";

  if (results.length === 0) {
    body.innerHTML = `<div class="empty-state">No results — collection may be empty or not indexed yet.</div>`;
    return;
  }

  body.innerHTML = results.map((r, i) => `
    <div class="result-item">
      <div class="result-rank">${i + 1}</div>
      <div>
        <div class="result-chunk-id">${r.chunkId}</div>
        <div class="result-blob-id">blob: ${r.blobId || "—"}</div>
        ${r.text ? `<div class="result-text">"${escapeHtml(r.text)}"</div>` : ""}
      </div>
      <div class="result-score">${(r.score ?? 0).toFixed(4)}</div>
    </div>
  `).join("");
}

// ─── Agents ───────────────────────────────────────────────────────────────────
function initAgents() {
  $("lookupAgentBtn").addEventListener("click", async () => {
    const addr = $("agentAddrInput").value.trim();
    if (!addr) { toast("Enter an agent address", "warn"); return; }

    try {
      // Call Aptos node view function via REST
      const url = `https://fullnode.testnet.aptoslabs.com/v1/accounts/${addr}/resource/${CONTRACT_ADDR}::agent_registry::AgentDID`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Agent not found on-chain");
      const { data } = await res.json();

      // Try to get reputation
      let scoreBps = null;
      try {
        const scoreUrl = `https://fullnode.testnet.aptoslabs.com/v1/accounts/${addr}/resource/${CONTRACT_ADDR}::reputation::AgentScore`;
        const scoreRes = await fetch(scoreUrl);
        if (scoreRes.ok) {
          const { data: sd } = await scoreRes.json();
          scoreBps = Number(sd.score_bps);
        }
      } catch { /* no score initialised */ }

      renderAgentInfo(addr, data, scoreBps);
      log(`[agents] loaded ${data.did}`, "ok");
    } catch (err) {
      toast(err.message, "error");
      log(`[agents] lookup error: ${err.message}`, "error");
    }
  });

  // Toggle register form
  $("toggleAgentForm").addEventListener("click", () => {
    const form = $("agentRegisterForm");
    const open = form.style.display === "block";
    form.style.display = open ? "none" : "block";
    $("toggleAgentForm").textContent = open ? "+ Expand" : "− Collapse";
  });

  ["agentName","agentVersion","agentFramework","agentCaps","agentMemCol"].forEach((id) => {
    $(id)?.addEventListener("input", updateAgentPreview);
  });
  $("registerAgentBtn").addEventListener("click", () => {
    updateAgentPreview();
    toast("CLI command ready below ↓", "ok");
  });
}

function renderAgentInfo(addr, data, scoreBps) {
  const panel = $("agentInfoPanel");
  const body  = $("agentInfoBody");
  panel.style.display = "block";

  const score       = scoreBps ?? 5000;
  const scorePercent = ((score / 10000) * 100).toFixed(1);

  body.innerHTML = `
    <div class="agent-grid">
      <div class="agent-did">${data.did ?? "—"}</div>
      <div class="agent-field">
        <div class="agent-field__label">Owner</div>
        <div class="agent-field__value">${shortAddr(data.owner)}</div>
      </div>
      <div class="agent-field">
        <div class="agent-field__label">Status</div>
        <div class="agent-field__value" style="color:${data.active ? 'var(--sage)' : 'var(--error)'}">
          ${data.active ? "● Active" : "○ Inactive"}
        </div>
      </div>
      <div class="agent-field">
        <div class="agent-field__label">Metadata Blob</div>
        <div class="agent-field__value">${shortAddr(data.metadata_blob_id)}</div>
      </div>
      <div class="agent-field">
        <div class="agent-field__label">Memory Collection</div>
        <div class="agent-field__value">
          ${data.memory_collection === "0x0" || !data.memory_collection
            ? "<span style='color:var(--text-lo)'>not linked</span>"
            : shortAddr(data.memory_collection)}
        </div>
      </div>
      <div class="score-bar-wrap">
        <div class="agent-field__label">Reputation — ${scorePercent}% (${score} bps)</div>
        <div class="score-bar">
          <div class="score-bar__fill" style="width:${scorePercent}%"></div>
        </div>
      </div>
    </div>
    <div style="margin-top:14px;display:flex;gap:8px">
      <a href="${APTOS_EXPLORER}/${addr}?network=${NETWORK}" target="_blank" rel="noopener">
        <button class="btn btn--ghost btn--sm">View on Explorer ↗</button>
      </a>
    </div>
  `;
}

function updateAgentPreview() {
  const name    = $("agentName").value    || "MyAgent";
  const version = $("agentVersion").value || "0.1.0";
  const fw      = $("agentFramework").value;
  const caps    = ($("agentCaps").value || "rag_query").split(",").map((s) => s.trim());
  const memCol  = $("agentMemCol").value.trim();

  const meta = {
    "@context":   "https://schema.org/",
    "@type":      "SoftwareAgent",
    identifier:   "pending",
    name,
    version,
    capabilities: caps,
    framework:    fw,
    ...(memCol ? { memoryCollection: memCol } : {}),
    createdAt: new Date().toISOString(),
  };

  const metaJson = JSON.stringify(meta, null, 2);
  const cmd = `# 1. Save metadata to file\ncat > agent-meta.json << 'EOF'\n${metaJson}\nEOF\n\n# 2. Upload to Shelby (returns BLOB_ID)\n# shelby upload agent-meta.json → BLOB_ID\n\n# 3. Register on-chain\naptos move run \\\n  --function-id '${CONTRACT_ADDR}::agent_registry::register_agent' \\\n  --args string:"<BLOB_ID>" \\\n  --profile shelbynet`;

  const preview = $("agentCmdPreview");
  preview.textContent = cmd;
  preview.classList.add("visible");
}

// ─── Logs ─────────────────────────────────────────────────────────────────────
function initLogs() {
  $("clearLogsBtn").addEventListener("click", () => {
    $("logTerminal").innerHTML = "";
    state.logCount = 0;
    log("[willow] logs cleared", "sys");
  });

  $("pauseLogsBtn").addEventListener("click", () => {
    state.logsPaused = !state.logsPaused;
    $("pauseLogsBtn").textContent = state.logsPaused ? "▶ Resume" : "⏸ Pause";
  });
}

function log(msg, level = "info") {
  if (state.logsPaused) return;
  const terminal = $("logTerminal");
  const now      = new Date().toLocaleTimeString("en-US", { hour12: false });
  const line     = document.createElement("div");
  line.className = `log-line log-line--${level}`;
  line.textContent = `${now}  ${msg}`;
  terminal.appendChild(line);
  state.logCount++;

  // Keep last 200 lines
  while (terminal.childElementCount > 200) terminal.removeChild(terminal.firstChild);
  terminal.scrollTop = terminal.scrollHeight;
  $("statAgents").textContent = state.logCount > 0 ? "—" : "—";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr ?? "—";
  return addr.slice(0, 8) + "…" + addr.slice(-6);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg, type = "ok") {
  const container = $("toastContainer");
  const el        = document.createElement("div");
  el.className    = `toast toast--${type}`;
  el.textContent  = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
