import { CONFIG } from "./config";
import type { ArchivedTab } from "./types";

/**
 * Archive-not-delete. The whole product's trust rests here: a tab is recorded
 * to storage BEFORE it is closed, and the most recent batch is one-click
 * restorable. Never hard-delete a tab.
 */

async function readArchive(): Promise<ArchivedTab[]> {
  const got = await chrome.storage.local.get(CONFIG.ARCHIVE_KEY);
  return (got[CONFIG.ARCHIVE_KEY] as ArchivedTab[] | undefined) ?? [];
}

export async function getArchive(): Promise<ArchivedTab[]> {
  return readArchive();
}

/**
 * Archive then close the given tabs. Returns how many were archived. The batch
 * is also stashed under UNDO_KEY so `undoLast()` can reopen it.
 */
export async function archiveAndClose(
  tabs: chrome.tabs.Tab[],
): Promise<number> {
  const now = Date.now();
  const batch: ArchivedTab[] = [];
  const idsToClose: number[] = [];

  for (const t of tabs) {
    if (t.id == null || !t.url) continue;
    batch.push({
      url: t.url,
      title: t.title ?? t.url,
      favIconUrl: t.favIconUrl,
      archivedAt: now,
    });
    idsToClose.push(t.id);
  }

  if (batch.length === 0) return 0;

  // 1. Persist BEFORE closing — if the close fails, nothing is lost.
  const archive = await readArchive();
  await chrome.storage.local.set({
    [CONFIG.ARCHIVE_KEY]: [...batch, ...archive],
    [CONFIG.UNDO_KEY]: batch,
  });

  // 2. Now it's safe to close.
  await chrome.tabs.remove(idsToClose);

  return batch.length;
}

/** Reopen every tab from the most recent archive batch. */
export async function undoLast(): Promise<number> {
  const got = await chrome.storage.local.get(CONFIG.UNDO_KEY);
  const batch = (got[CONFIG.UNDO_KEY] as ArchivedTab[] | undefined) ?? [];
  for (const tab of batch) {
    await chrome.tabs.create({ url: tab.url, active: false });
  }
  await chrome.storage.local.remove(CONFIG.UNDO_KEY);
  return batch.length;
}
