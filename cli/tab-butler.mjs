#!/usr/bin/env node
/**
 * tab-butler CLI — list, kill, and Claude-clean localhost dev servers.
 * Zero dependencies (Node 18+). The terminal is the right home for this: no
 * browser, no native messaging, no menubar app.
 *
 *   tab-butler ls            list listening dev servers (port, RAM, uptime)
 *   tab-butler kill <port>   SIGTERM whatever listens on <port>
 *   tab-butler clean [--yes] ask Claude which look stale, then kill them
 *
 * `clean` needs ANTHROPIC_API_KEY in the environment.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

const pexec = promisify(execFile);

const DEV_CMDS = [
  "node", "deno", "bun", "python", "ruby", "php", "rails", "puma", "vite",
  "next", "webpack", "cargo", "go", "dotnet", "java", "gradle", "flask",
  "gunicorn", "uvicorn",
];

async function run(cmd, args) {
  try {
    const { stdout } = await pexec(cmd, args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    return e.stdout || "";
  }
}

async function listServers() {
  const [lsof, ps] = await Promise.all([
    run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]),
    run("ps", ["-axo", "pid=,rss=,etime=,comm="]),
  ]);

  const proc = new Map();
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) proc.set(Number(m[1]), { ramMB: Math.round(Number(m[2]) / 1024), uptime: m[3], comm: m[4] });
  }

  const seen = new Set();
  const servers = [];
  for (const line of lsof.split("\n").slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length < 9) continue;
    const command = cols[0];
    const pid = Number(cols[1]);
    const portMatch = (cols[8] || "").match(/:(\d+)$/);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    if (seen.has(port)) continue;
    if (!DEV_CMDS.some((c) => command.toLowerCase().startsWith(c))) continue;
    seen.add(port);
    const info = proc.get(pid) || {};
    servers.push({ port, pid, command, ramMB: info.ramMB ?? null, uptime: info.uptime ?? "?" });
  }
  return servers.sort((a, b) => a.port - b.port);
}

async function killPort(port) {
  const out = await run("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"]);
  const pids = out.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const pid of pids) {
    try { process.kill(Number(pid), "SIGTERM"); } catch { /* gone */ }
  }
  return pids;
}

function table(servers) {
  if (!servers.length) return "No dev servers listening.";
  const head = "  PORT      RAM       UPTIME   COMMAND";
  const rows = servers.map(
    (s) =>
      `  ${String(s.port).padEnd(6)}  ${(s.ramMB != null ? s.ramMB + " MB" : "?").padStart(7)}  ${String(s.uptime).padStart(9)}   ${s.command}`,
  );
  return [head, ...rows].join("\n");
}

async function adviseClean(servers) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY to use `clean` (or use `kill <port>`).");
  const system =
    "You help a developer clean up forgotten localhost dev servers. Given a JSON list (port, command, ramMB, uptime), pick which look STALE/forgotten and safe to stop — long uptime, high RAM, throwaway tooling (Storybook, webpack-dev-server, old one-off scripts). Be conservative; keep anything that looks like an active app server. Return ONLY JSON: {\"kill\":[{\"port\":N,\"reason\":\"short\"}],\"summary\":\"one line\"}.";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: JSON.stringify(servers) }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

function confirm(q) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "kill") {
  const port = Number(arg);
  if (!port) { console.error("usage: tab-butler kill <port>"); process.exit(1); }
  const pids = await killPort(port);
  console.log(pids.length ? `Killed :${port} (pid ${pids.join(", ")})` : `Nothing listening on :${port}`);
} else if (cmd === "clean") {
  const servers = await listServers();
  console.log("Dev servers:\n" + table(servers) + "\n");
  if (!servers.length) process.exit(0);
  let advice;
  try { advice = await adviseClean(servers); } catch (e) { console.error(e.message); process.exit(1); }
  console.log("Claude: " + (advice.summary || ""));
  if (!advice.kill?.length) { console.log("Nothing worth cleaning up."); process.exit(0); }
  for (const k of advice.kill) console.log(`  • :${k.port} — ${k.reason}`);
  const yes = process.argv.includes("--yes") || (await confirm(`\nKill ${advice.kill.length} server(s)? [y/N] `));
  if (yes) for (const k of advice.kill) console.log(`  killed :${k.port} (${(await killPort(k.port)).length} pid)`);
  else console.log("Aborted.");
} else {
  console.log(table(await listServers()));
}
