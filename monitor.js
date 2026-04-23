#!/usr/bin/env node
/**
 * Claude Code Session Monitor
 *
 * Real-time web UI showing multiple Claude Code sessions + log files in a
 * split-panel terminal view. Polls tmux panes and log files every 2s,
 * streams updates to the browser via SSE. Supports dynamic parallel task panels.
 *
 * Usage:
 *   node monitor.js [sessions.json]
 *
 * If no config file is specified, looks for sessions.json in the current directory.
 * Copy sessions.example.json → sessions.json and edit for your setup.
 *
 * Session types:
 *   tmux        — local tmux pane (target: "session:window")
 *   remote-tmux — tmux inside a Docker container (SSH required)
 *   logfile     — tail a local log file
 *
 * Parallel tasks: the monitor auto-discovers running tasks by scanning
 * PARALLEL_DIR (env var, default: ./logs/parallel) for *.meta.json files
 * with status=running. Set via PARALLEL_DIR env var.
 *
 * Access: http://localhost:<PORT>  (PORT env var, default 18794)
 */

"use strict";

const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const { execSync } = require("child_process");

const PORT         = parseInt(process.env.PORT || "18794");
const PARALLEL_DIR = process.env.PARALLEL_DIR || path.join(process.cwd(), "logs", "parallel");

// Load session config
const configPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.cwd(), "sessions.json");

if (!fs.existsSync(configPath)) {
  console.error(`[monitor] Config not found: ${configPath}`);
  console.error(`[monitor] Copy sessions.example.json → sessions.json and edit for your setup.`);
  process.exit(1);
}

const SESSIONS = JSON.parse(fs.readFileSync(configPath, "utf8"));

// ── Per-session state ─────────────────────────────────────────────────────────
const state = {};
SESSIONS.forEach(s => { state[s.id] = { content: "", updateTime: null }; });

const parallelTasks = {};
let clients = [];

// ── Source readers ────────────────────────────────────────────────────────────
function trimTrailingBlankLines(raw) {
  if (!raw) return raw;
  // Strip trailing whitespace-only lines. Avoid nested-quantifier ReDoS
  // (the old /(\s*\n)+$/ on whitespace-heavy tmux captures caused catastrophic
  // backtracking — see Agent-Crafting-Table/claude-code-session-monitor#1).
  return raw.replace(/\s+$/, "") + "\n";
}

function readTmux(target) {
  try {
    const raw = execSync(`tmux capture-pane -p -t ${target} -S -500 2>/dev/null`, { encoding: "utf8", timeout: 3000 });
    return trimTrailingBlankLines(raw);
  } catch { return null; }
}

function readRemoteTmux(session) {
  const { container, target, sshHost, sshKey } = session;
  const keyFlag = sshKey ? `-i ${sshKey}` : "";
  try {
    const raw = execSync(
      `ssh ${keyFlag} -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes ${sshHost} ` +
      `"docker exec ${container} tmux capture-pane -p -t ${target} -S -500 2>/dev/null"`,
      { encoding: "utf8", timeout: 8000 },
    );
    return trimTrailingBlankLines(raw);
  } catch { return null; }
}

function readLogFile(file, lines = 200) {
  try {
    if (!fs.existsSync(file)) return "(no log yet)";
    const content = fs.readFileSync(file, "utf8");
    return content.split("\n").slice(-lines).join("\n");
  } catch { return null; }
}

function fetchContent(session) {
  switch (session.type) {
    case "tmux":        return readTmux(session.target);
    case "remote-tmux": return readRemoteTmux(session);
    case "logfile":     return readLogFile(session.file);
    default:            return null;
  }
}

// ── Parallel task scanner ────────────────────────────────────────────────────
function scanParallelTasks() {
  try {
    if (!fs.existsSync(PARALLEL_DIR)) return;
    const files = fs.readdirSync(PARALLEL_DIR);
    const metaFiles = files.filter(f => f.endsWith(".meta.json"));
    const activeTasks = new Set();

    for (const mf of metaFiles) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(PARALLEL_DIR, mf), "utf8"));
        const taskId = meta.id;
        if (meta.status !== "running") continue;

        activeTasks.add(taskId);
        const logFile = path.join(PARALLEL_DIR, `${taskId}.log`);
        const content = readLogFile(logFile, 300) || "(starting...)";

        const isNew = !parallelTasks[taskId];
        const changed = isNew || parallelTasks[taskId].content !== content;

        parallelTasks[taskId] = {
          meta,
          content,
          updateTime: changed ? Date.now() : (parallelTasks[taskId]?.updateTime || Date.now()),
        };

        if (isNew) broadcast({ type: "parallel_add", task: formatParallelSession(taskId) });
        if (changed) broadcast({ id: taskId, content });
      } catch {}
    }

    for (const taskId of Object.keys(parallelTasks)) {
      if (!activeTasks.has(taskId)) {
        broadcast({ type: "parallel_remove", taskId });
        delete parallelTasks[taskId];
        delete state[taskId];
      }
    }
  } catch {}
}

function formatParallelSession(taskId) {
  const pt = parallelTasks[taskId];
  if (!pt) return null;
  const m = pt.meta;
  const statusIcon = m.status === "running" ? "🔄" : m.status === "done" ? "✅" : "❌";
  return {
    id: taskId,
    label: `${statusIcon} ${m.task ? m.task.slice(0, 50) : taskId}`,
    color: m.status === "running" ? "#f0883e" : m.status === "done" ? "#3fb950" : "#f85149",
    type: "parallel",
    status: m.status,
  };
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  clients = clients.filter(res => {
    try { res.write(data); return true; }
    catch { return false; }
  });
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
let tick = 0;

function poll() {
  tick++;
  SESSIONS.forEach(session => {
    if (session.type === "remote-tmux" && tick % 3 !== 0) return;
    const content = fetchContent(session);
    if (content === null) return;
    if (content !== state[session.id].content) {
      state[session.id].content = content;
      state[session.id].updateTime = Date.now();
      broadcast({ id: session.id, content });
    }
  });
  scanParallelTasks();
}

// ── HTML ──────────────────────────────────────────────────────────────────────
const sessionsJson = JSON.stringify(SESSIONS.map(({ id, label, color, type, termUrl }) => ({ id, label, color, type, termUrl: termUrl || null })));

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Session Monitor</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #c9d1d9; --muted: #8b949e; --dim: #484f58; }
html, body { height: 100%; background: var(--bg); color: var(--text); font-family: ui-monospace, 'SF Mono', monospace; font-size: 12px; }
body { display: flex; flex-direction: column; }
header { padding: 10px 16px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
header h1 { font-size: 13px; font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; box-shadow: 0 0 4px #3fb950; transition: background 0.3s; }
.dot.off { background: #f85149; box-shadow: 0 0 4px #f85149; }
.status { font-size: 11px; color: var(--muted); margin-left: auto; }
.grid { display: grid; gap: 1px; background: var(--border); flex: 1; overflow: hidden; min-height: 0; }
.panel { background: var(--bg); display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
.panel-header { padding: 5px 10px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.panel-label { font-size: 11px; font-weight: 600; }
.panel-ts { font-size: 10px; color: var(--dim); margin-left: auto; }
.panel-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.panel-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; line-height: 1.55; font-size: 11.5px; color: var(--text); min-height: 0; }
.panel-body::-webkit-scrollbar { width: 3px; }
.panel-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
.parallel-zone { display: flex; flex-direction: column; gap: 1px; background: var(--border); overflow: hidden; min-height: 0; }
.parallel-zone .panel { flex: 1 1 0; min-height: 0; }
.open-btn { font-size: 9px; padding: 1px 6px; background: transparent; border: 1px solid var(--border); color: var(--muted); border-radius: 3px; cursor: pointer; font-family: inherit; line-height: 1.4; transition: border-color 0.15s, color 0.15s; }
.open-btn:hover { border-color: #58a6ff; color: #58a6ff; }
.term-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.75); z-index: 100; justify-content: center; align-items: center; }
.term-overlay.active { display: flex; }
.term-modal { width: 90vw; height: 85vh; background: #0d1117; border: 1px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; }
.term-modal-head { padding: 8px 14px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.term-modal-title { font-size: 12px; font-weight: 600; flex: 1; }
.term-modal-close { background: #f85149; border: none; color: #fff; padding: 3px 10px; border-radius: 5px; cursor: pointer; font-size: 11px; font-family: inherit; }
.term-modal-body { flex: 1; overflow: hidden; padding: 4px; }
#term-iframe { width: 100%; height: 100%; border: none; border-radius: 6px; }
</style>
</head>
<body>
<header>
  <div class="dot" id="dot"></div>
  <h1>📡 Session Monitor</h1>
  <span class="status" id="status">connecting…</span>
</header>
<div class="grid" id="grid" style="grid-template-columns: repeat(${Math.min(SESSIONS.length, 3)}, 1fr)"></div>
<div class="term-overlay" id="term-overlay" onclick="if(event.target===this)closeTerminal()">
  <div class="term-modal">
    <div class="term-modal-head">
      <span class="term-modal-title" id="term-title">Terminal</span>
      <button class="term-modal-close" onclick="closeTerminal()">✕ Close</button>
    </div>
    <div class="term-modal-body"><iframe id="term-iframe" src="" allow="*"></iframe></div>
  </div>
</div>
<script>
const SESSIONS = ${sessionsJson};
const panels = {}, parallelPanels = {};

function openTerminal(id, label, url) {
  document.getElementById('term-title').textContent = label + ' — Terminal';
  document.getElementById('term-iframe').src = url;
  document.getElementById('term-overlay').classList.add('active');
}
function closeTerminal() {
  document.getElementById('term-overlay').classList.remove('active');
  document.getElementById('term-iframe').src = '';
}
function isAtBottom(el) { return el.scrollHeight - el.scrollTop <= el.clientHeight + 60; }

function makePanel(id, label, color, type, termUrl) {
  const el = document.createElement('div');
  el.className = 'panel'; el.dataset.id = id;
  const hasTmux = type === 'tmux' || type === 'remote-tmux';
  el.innerHTML =
    '<div class="panel-header"' + (termUrl ? ' style="cursor:pointer" onclick="openTerminal(\\'' + id + '\\',\\'' + label + '\\',\\'' + termUrl + '\\')"' : '') + '>' +
      '<div class="panel-dot" style="background:' + color + ';box-shadow:0 0 4px ' + color + '40"></div>' +
      '<span class="panel-label" style="color:' + color + '">' + label + '</span>' +
      '<span class="panel-ts" id="ts-' + id + '">—</span>' +
      (termUrl && hasTmux ? '<button class="open-btn" onclick="event.stopPropagation();openTerminal(\\'' + id + '\\',\\'' + label + '\\',\\'' + termUrl + '\\')" title="Open terminal">⌨ Open</button>' : '') +
    '</div>' +
    '<div class="panel-body" id="body-' + id + '">connecting…</div>';
  return el;
}

function init() {
  const grid = document.getElementById('grid');
  SESSIONS.forEach(s => {
    const el = makePanel(s.id, s.label, s.color, s.type, s.termUrl);
    grid.appendChild(el);
    panels[s.id] = { body: document.getElementById('body-' + s.id), ts: document.getElementById('ts-' + s.id) };
  });
}

function addParallelPanel(task) {
  parallelPanels[task.id] = null;
  let pz = document.getElementById('parallel-zone');
  if (!pz) {
    pz = document.createElement('div');
    pz.className = 'parallel-zone'; pz.id = 'parallel-zone';
    document.getElementById('grid').appendChild(pz);
  }
  const el = makePanel(task.id, task.label, task.color, 'parallel', null);
  pz.appendChild(el);
  parallelPanels[task.id] = { body: document.getElementById('body-' + task.id), ts: document.getElementById('ts-' + task.id), el };
}

function removeParallelPanel(taskId) {
  const pp = parallelPanels[taskId];
  if (pp && pp.el) pp.el.remove();
  delete parallelPanels[taskId];
  const pz = document.getElementById('parallel-zone');
  if (pz && !pz.children.length) pz.remove();
}

function connect() {
  const es = new EventSource('/stream');
  const dot = document.getElementById('dot'), status = document.getElementById('status');
  let count = 0;
  es.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'parallel_add') { addParallelPanel(msg.task); count++; status.textContent = count + ' updates'; return; }
    if (msg.type === 'parallel_remove') { removeParallelPanel(msg.taskId); count++; status.textContent = count + ' updates'; return; }
    const { id, content } = msg;
    const p = panels[id] || parallelPanels[id];
    if (!p) return;
    const snap = isAtBottom(p.body);
    p.body.textContent = content;
    p.ts.textContent = new Date().toLocaleTimeString();
    count++; status.textContent = count + ' updates';
    if (snap) p.body.scrollTop = p.body.scrollHeight;
  };
  es.onopen = () => { dot.className = 'dot'; status.textContent = 'live'; };
  es.onerror = () => { dot.className = 'dot off'; status.textContent = 'reconnecting…'; es.close(); setTimeout(connect, 3000); };
}

init(); connect();
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    res.write(": connected\n\n");
    clients.push(res);
    SESSIONS.forEach(s => { const c = state[s.id].content; if (c) res.write(`data: ${JSON.stringify({ id: s.id, content: c })}\n\n`); });
    for (const [taskId, pt] of Object.entries(parallelTasks)) {
      const taskInfo = formatParallelSession(taskId);
      if (taskInfo) {
        res.write(`data: ${JSON.stringify({ type: "parallel_add", task: taskInfo })}\n\n`);
        if (pt.content) res.write(`data: ${JSON.stringify({ id: taskId, content: pt.content })}\n\n`);
      }
    }
    req.on("close", () => { clients = clients.filter(c => c !== res); });
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: clients.length, tick, parallelTasks: Object.keys(parallelTasks).length }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(HTML);
});

server.on("error", err => {
  if (err.code === "EADDRINUSE") { console.error(`[monitor] Port ${PORT} already in use`); process.exit(0); }
  throw err;
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[monitor] Live at http://0.0.0.0:${PORT}`);
  console.log(`[monitor] Sessions: ${SESSIONS.map(s => s.id).join(", ")}`);
  console.log(`[monitor] Parallel tasks dir: ${PARALLEL_DIR}`);
});

setInterval(poll, 2000);
poll();
