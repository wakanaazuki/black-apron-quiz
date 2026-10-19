#!/usr/bin/env node
/**
 * validate-mock-bank.mjs — 本試験モード用問題バンク(data/mock/bank.js)の検証
 * 使い方: cd tools && npm run validate:mock
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
eval(readFileSync(join(ROOT, "core.js"), "utf8"));
const Core = globalThis.Core;
eval(readFileSync(join(ROOT, "data", "mock", "bank.js"), "utf8"));
const BANK = globalThis.MOCK_BANK;

const errors = [], warns = [];
const ids = new Set();
let single = 0, multi = 0, original = 0, verify = 0;
const pos = {};

for (const raw of BANK) {
  const q = Core.normalizeQuestion(raw);
  if (!q.id) { errors.push("IDなし"); continue; }
  if (ids.has(q.id)) errors.push(`ID重複: ${q.id}`);
  ids.add(q.id);
  if (!q.question.trim()) errors.push(`空の問題文: ${q.id}`);
  if (!q.explanation.trim()) errors.push(`空の解説: ${q.id}`);
  const texts = q.choices.map(c => Core.normText(c.text));
  if (new Set(texts).size !== texts.length) errors.push(`選択肢が重複: ${q.id}`);
  const cids = q.choices.map(c => c.id);
  q.answerIds.forEach(a => { if (!cids.includes(a)) errors.push(`answerIdsが不正: ${q.id}`); });

  if (q.type === "multi") {
    multi++;
    if (q.choices.length !== 5) errors.push(`多肢選択は5択のはず: ${q.id} (${q.choices.length})`);
    if (q.answerIds.length < 2) errors.push(`多肢選択の正解が2つ未満: ${q.id}`);
    if (q.answerIds.length >= q.choices.length) errors.push(`多肢選択の全選択肢が正解: ${q.id}`);
  } else {
    single++;
    if (q.choices.length !== 4) errors.push(`択一は4択のはず: ${q.id} (${q.choices.length})`);
    if (q.answerIds.length !== 1) errors.push(`択一の正解は1つのはず: ${q.id}`);
  }
  if (q.origin === "original") original++;
  if (q.verify) { verify++; warns.push(`要確認: ${q.id} — ${q.question.slice(0, 40)}…`); }
  if (!q.sources || !q.sources.length) errors.push(`出典なし: ${q.id}`);
}

// 登録順の正解位置の偏り(A固定などを防ぐ)
{
  const sp = [0, 0, 0, 0], mp = [0, 0, 0, 0, 0];
  for (const raw of BANK) {
    const q = Core.normalizeQuestion(raw);
    q.choices.forEach((c, i) => { if (q.answerIds.includes(c.id)) (q.type === "multi" ? mp : sp)[i]++; });
  }
  console.log(`  正解位置(択一 A/B/C/D): ${sp.join(" / ")}`);
  console.log(`  正解位置(多肢の正解選択肢 A〜E): ${mp.join(" / ")}`);
  const ss = sp.reduce((a, b) => a + b, 0), ms = mp.reduce((a, b) => a + b, 0);
  if (Math.max(...sp) / ss > 0.30) errors.push(`択一の正解位置が偏っています: ${sp.join("/")}`);
  if (Math.max(...mp) / ms > 0.26) errors.push(`多肢の正解位置が偏っています: ${mp.join("/")}`);
}

// 出題可能数
if (single < Core.MOCK_SINGLE_COUNT) errors.push(`択一が不足: ${single}/${Core.MOCK_SINGLE_COUNT}`);
if (multi < Core.MOCK_MULTI_COUNT) errors.push(`多肢選択が不足: ${multi}/${Core.MOCK_MULTI_COUNT}`);

// 同一問題文の重複(正規化後)
const seen = new Map();
for (const q of BANK) {
  const k = Core.normText(q.question);
  if (seen.has(k)) warns.push(`問題文が酷似: ${q.id} と ${seen.get(k)}`);
  seen.set(k, q.id);
}

console.log(`問題バンク: ${BANK.length}問(択一${single} / 多肢${multi})`);
console.log(`  資料に選択肢があった問題: ${original}問 / 問答・穴埋めからの変換: ${BANK.length - original}問`);
console.log(`  原本確認が必要(verify): ${verify}問`);
if (warns.length) { console.log("\n警告:"); warns.forEach(w => console.log("  ⚠ " + w)); }
if (errors.length) { console.log("\nエラー:"); errors.forEach(e => console.log("  ✗ " + e)); process.exit(1); }
console.log("\n✓ 問題バンクの検証を通過しました");
