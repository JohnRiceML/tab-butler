import type { AdviceResult, Message } from "../lib/types";

function send<T>(msg: Message): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

const out = document.getElementById("out") as HTMLDivElement;
const status = document.getElementById("status") as HTMLDivElement;

function show(text: string) {
  out.textContent = text;
}

async function refreshStatus() {
  const s = await send<{ smart: boolean; archived: number }>({ type: "GET_STATE" });
  status.textContent = `${s.smart ? "Smart (Claude) on" : "Local only"} · ${s.archived} archived`;
}

document.getElementById("group")!.addEventListener("click", async () => {
  show("Grouping…");
  const r = await send<{ applied: number; smart: boolean }>({ type: "GROUP_NOW" });
  show(`Created ${r.applied} group(s)${r.smart ? " with Claude." : " by site."}`);
});

document.getElementById("advise")!.addEventListener("click", async () => {
  show("Asking Claude…");
  const r = await send<AdviceResult>({ type: "ADVISE_NOW" });
  const lines = r.recommendations.map((rec) => `• ${rec.title} — ${rec.detail}`);
  show([r.summary, ...lines].join("\n"));
});

document.getElementById("archive")!.addEventListener("click", async () => {
  show("Archiving idle tabs…");
  const r = await send<{ archived: number }>({ type: "ARCHIVE_IDLE_NOW" });
  show(`Archived ${r.archived} idle tab(s). Use Undo to bring them back.`);
  void refreshStatus();
});

document.getElementById("undo")!.addEventListener("click", async () => {
  const r = await send<{ restored: number }>({ type: "UNDO_LAST" });
  show(`Restored ${r.restored} tab(s).`);
  void refreshStatus();
});

void refreshStatus();
