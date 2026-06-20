#!/usr/bin/env node
/**
 * Tab Butler native messaging host. Chrome's sandbox can't run OS commands, so
 * the extension delegates "list / kill dev servers" to this small local helper.
 *
 * Protocol: Chrome spawns this per message (sendNativeMessage), writes one
 * length-prefixed JSON request to stdin, and reads one length-prefixed JSON
 * reply from stdout. We handle exactly one message, then exit.
 *
 *   { "action": "list" }              -> { ok, servers: [{port, pid, command}] }
 *   { "action": "kill", "port": N }   -> { ok, killed: [pid], port } | { ok:false, error }
 *
 * Only LISTENING sockets are touched, and only on explicit request from our
 * extension (enforced by the host manifest's allowed_origins).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

function readMessage() {
  return new Promise((resolve) => {
    const chunks = [];
    let needed = null;
    process.stdin.on("data", (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      if (needed === null && buf.length >= 4) needed = buf.readUInt32LE(0);
      if (needed !== null && buf.length >= 4 + needed) {
        try {
          resolve(JSON.parse(buf.slice(4, 4 + needed).toString("utf8")));
        } catch {
          resolve(null);
        }
      }
    });
    process.stdin.on("end", () => resolve(null));
  });
}

function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([len, json]));
}

async function listServers() {
  try {
    const { stdout } = await pexec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { maxBuffer: 4 * 1024 * 1024 });
    const byPort = new Map();
    for (const line of stdout.split("\n").slice(1)) {
      if (!line) continue;
      const cols = line.split(/\s+/);
      const command = cols[0];
      const pid = Number(cols[1]);
      const name = cols[8] || "";
      const m = name.match(/(?:127\.0\.0\.1|\[::1\]|\*|localhost):(\d+)$/);
      if (!m) continue;
      const port = Number(m[1]);
      if (!byPort.has(port)) byPort.set(port, { port, pid, command });
    }
    return [...byPort.values()].sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

async function killPort(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: "invalid port" };
  }
  try {
    const { stdout } = await pexec("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"]);
    const pids = stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
    if (!pids.length) return { ok: false, error: `nothing listening on :${port}` };
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    return { ok: true, killed: pids, port };
  } catch (e) {
    // lsof exits non-zero when nothing matches
    return { ok: false, error: `nothing listening on :${port}` };
  }
}

const msg = await readMessage();
if (msg) {
  let reply;
  if (msg.action === "list") reply = { ok: true, servers: await listServers() };
  else if (msg.action === "kill") reply = await killPort(Number(msg.port));
  else reply = { ok: false, error: "unknown action" };
  writeMessage(reply);
}
process.exit(0);
