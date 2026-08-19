import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transform } from "esbuild";

const source = await fs.readFile(new URL("../src/lib/posting-analytics.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
let assertions = 0;
const eq = (actual, expected, message) => { assertions++; assert.equal(actual, expected, message); };
const ok = (actual, message) => { assertions++; assert.ok(actual, message); };

const parsed = mod.parseAnalyticsCsv('\ufeffA,B,C\r\n1,"a, b","line 1\nline 2"\r\n2,"said ""hi""",x\r\n');
eq(parsed.length, 3, "CSV parser preserves two data rows");
eq(parsed[1][1], "a, b", "quoted commas stay inside the field");
eq(parsed[1][2], "line 1\nline 2", "quoted newlines stay inside the field");
eq(parsed[2][1], 'said "hi"', "escaped quotes decode");
assertions++; assert.throws(() => mod.parseAnalyticsCsv('A,B\n"broken'), /quoted field/, "unclosed quotes fail clearly");

const headers = ["Post id", "Date", "Post text", "Post Link", "Impressions", "Likes", "Engagements", "Bookmarks", "Shares", "New follows", "Replies", "Reposts", "Profile visits"];
const quote = (value) => {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const records = [];
let postId = 1;
const add = (date, text, impressions, engagements, follows, profileVisits) => records.push([
  postId++, date, text, `https://x.com/test/status/${postId}`, impressions, 0, engagements, 0, 0, follows, 0, 0, profileVisits,
]);

for (let i = 0; i < 6; i++) add(`2026-07-${String(i + 1).padStart(2, "0")}`, `Drop what you are building below. I want to meet more thoughtful operators working on real customer problems ${i}.`, 1_200, 120, 8, 34);
for (let i = 0; i < 6; i++) add(`2026-07-${String(i + 7).padStart(2, "0")}`, `We crossed ${20 + i} customers after changing one onboarding step. The useful part was watching where people stopped ${i}.`, 1_500, 160, 7, 42);
for (let i = 0; i < 8; i++) add(`2026-07-${String(i + 13).padStart(2, "0")}`, `A longer baseline observation ${i} that deliberately contains no winning structure and keeps going with ordinary words so it lands in the next character band instead of the compact one. private-marker-${i}`, i === 0 ? -50 : 800, 20, 1, 5);
for (let i = 0; i < 14; i++) add(`2026-07-${String(i + 1).padStart(2, "0")}`, `@person${i} The useful distinction is whether the workflow removes a decision or only moves it somewhere less visible for the team.`, 100, 10, 1, 4);
for (let i = 0; i < 10; i++) add(`2026-07-${String(i + 1).padStart(2, "0")}`, `@other${i} This is a deliberately longer response that keeps adding neutral explanation without a stronger outcome. It should form the comparison band for the importer and demonstrate that character guidance is learned from aggregate response outcomes rather than fixed globally for every account.`, 100, 5, 0, 1);

const csv = [headers, ...records].map((row) => row.map(quote).join(",")).join("\r\n");
const model = mod.buildPersonalPostingModel(csv, "@TestOwner", 123456);
eq(model.version, 1, "model is versioned");
eq(model.ownerHandle, "testowner", "owner handle is normalized");
eq(model.importedAt, 123456, "import timestamp is explicit");
eq(model.rows, 44, "all usable rows are aggregated");
eq(model.originals.posts, 20, "originals are separated from replies");
eq(model.replies.posts, 24, "leading-handle rows are replies");
eq(model.range.from, "2026-07-01", "date range starts at the earliest row");
eq(model.range.to, "2026-07-20", "date range ends at the latest row");
ok(model.recommendations.patterns.includes("community-invitation"), "community invitations can win from a user's own outcomes");
ok(model.recommendations.patterns.includes("quantified-proof"), "quantified proof can win from a user's own outcomes");
eq(model.recommendations.originalLength, "101-180", "original length is learned from eligible aggregate outcomes");
eq(model.recommendations.replyLength, "101-180", "reply length is learned only with enough reply rows");
eq(model.originals.impressions, 21_800, "negative metrics are clamped to zero rather than corrupting totals");
ok(!JSON.stringify(model).includes("private-marker"), "persisted model contains no raw post text");
ok(mod.isPersonalPostingModel(model), "stored-model guard accepts valid aggregates");
ok(!mod.isPersonalPostingModel({ version: 1 }), "stored-model guard rejects partial data");
ok(mod.postingModelIsActive(model, "@TESTOWNER"), "owner match is case-insensitive");
ok(!mod.postingModelIsActive(model, "someoneelse"), "model is inactive for another account");

const ideas = mod.postingModelIdeasGuidance(model, "testowner");
ok(/Historical personal posting model/.test(ideas), "ideas get an explicit historical-evidence label");
ok(/Correlation only/.test(ideas), "ideas guidance preserves the correlation caveat");
ok(/at most 3 of 5 ideas/.test(ideas), "personal evidence cannot make the whole batch repetitive");
ok(!ideas.includes("private-marker"), "ideas guidance contains no source-row text");
eq(mod.postingModelIdeasGuidance(model, "wrongowner"), "", "ideas ignore another owner's model");
const community = mod.postingModelCommunityGuidance(model, "testowner");
ok(/101-180 characters/.test(community), "Community Spark receives the learned reply band");
ok(/never pad/.test(community) && /correlation only/i.test(community), "reply guidance prevents causal or length-padding misuse");

assertions++; assert.throws(() => mod.buildPersonalPostingModel("Date,Post text\n2026-01-01,hello", "testowner"), /Missing:/, "wrong exports fail with missing-header detail");
assertions++; assert.throws(() => mod.buildPersonalPostingModel(csv, ""), /Set and save/, "imports require an owner handle");
assertions++; assert.throws(() => mod.buildPersonalPostingModel(`${headers.join(",")}\n`, "testowner"), /no analytics rows/i, "header-only exports fail clearly");

const popup = await fs.readFile(new URL("../src/popup/popup.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../src/background/service-worker.ts", import.meta.url), "utf8");
const client = await fs.readFile(new URL("../src/lib/claude-client.ts", import.meta.url), "utf8");
ok(/type="file"[^>]+accept="\.csv,text\/csv"/.test(popup), "popup exposes an accessible CSV file input");
ok(/raw rows are never saved or uploaded/i.test(popup), "import UI states the local aggregate boundary");
ok(/clear-posting-model/.test(popup), "the user can reset the imported model");
ok(/postingModelIdeasGuidance/.test(worker) && /postingModelCommunityGuidance/.test(worker), "background applies the model to Ideas and Community Spark");
ok(/IMPORTED PERSONAL POSTING EVIDENCE/.test(client), "post generation labels imported evidence separately");

console.log(`\n✓ posting analytics: ${assertions} assertions passed`);
