/* 本試験モード(core.js)の単体テスト: 出題構成 / 完全一致採点 / 復元 / タイマー / バックアップ */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
eval(readFileSync(join(ROOT, "core.js"), "utf8"));
const Core = globalThis.Core;
eval(readFileSync(join(ROOT, "data", "mock", "bank.js"), "utf8"));
const BANK = globalThis.MOCK_BANK;

// 再現性のある乱数
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

test("本試験は 4択80問 + 5択20問 の計100問で組まれる", () => {
  const items = Core.buildMockExam(BANK, lcg(1));
  assert.equal(items.length, 100);
  const singles = items.slice(0, 80), multis = items.slice(80);
  assert.ok(singles.every(q => q.type !== "multi" && q.choices.length === 4 && q.answerIds.length === 1));
  assert.ok(multis.every(q => q.type === "multi" && q.choices.length === 5 && q.answerIds.length >= 2));
  assert.equal(new Set(items.map(q => q.id)).size, 100, "問題IDが重複しない");
});

test("出題ごとに問題の抽出・選択肢の並びが変わる", () => {
  const a = Core.buildMockExam(BANK, lcg(1)).map(q => q.id + q.choices.map(c => c.id).join(""));
  const b = Core.buildMockExam(BANK, lcg(2)).map(q => q.id + q.choices.map(c => c.id).join(""));
  assert.notDeepEqual(a, b);
});

test("問題が不足していれば例外(80問/20問に満たない場合)", () => {
  assert.throws(() => Core.buildMockExam(BANK.filter(q => q.type === "multi")), /択一/);
  assert.throws(() => Core.buildMockExam(BANK.filter(q => q.type !== "multi")), /多肢/);
});

test("採点は完全一致のみ正解(部分点なし・多め/少なめ選択は不正解・未解答は不正解)", () => {
  const items = Core.buildMockExam(BANK, lcg(3));
  const answers = {};
  items.forEach((q, i) => {
    if (i < 70) answers[q.id] = q.answerIds.slice();          // 択一70問 正解
    else if (i < 75) answers[q.id] = [q.choices.find(c => !q.answerIds.includes(c.id)).id]; // 択一5問 不正解
    // 75〜79 は未解答
    else if (i >= 80 && i < 90) answers[q.id] = q.answerIds.slice(); // 多肢10問 完全一致
    else if (i >= 90 && i < 95) answers[q.id] = q.answerIds.slice(1); // 多肢5問 不足(部分点なし)
    else if (i >= 95 && i < 98) answers[q.id] = q.choices.map(c => c.id); // 多肢3問 全選択(過剰)
    // 98〜99 未解答
  });
  const r = Core.scoreMock(items, answers);
  assert.equal(r.correct, 80);
  assert.equal(r.single.correct, 70);
  assert.equal(r.multi.correct, 10);
  assert.equal(r.unanswered, 7);
  assert.equal(r.rate, 80);
  assert.equal(r.passed, true);
});

test("合格ライン: 79%は不合格、全問正解は合格、全未解答は0点", () => {
  const items = Core.buildMockExam(BANK, lcg(4));
  const all = {}; items.forEach(q => { all[q.id] = q.answerIds.slice(); });
  assert.equal(Core.scoreMock(items, all).passed, true);
  assert.equal(Core.scoreMock(items, all).rate, 100);
  const some = Object.assign({}, all);
  for (let i = 0; i < 21; i++) delete some[items[i].id];
  const r = Core.scoreMock(items, some);
  assert.equal(r.correct, 79);
  assert.equal(r.passed, false);
  const z = Core.scoreMock(items, {});
  assert.equal(z.correct, 0); assert.equal(z.unanswered, 100); assert.equal(z.passed, false);
});

test("スナップショット → 復元で問題・選択肢の並びが完全に再現される", () => {
  const items = Core.buildMockExam(BANK, lcg(5));
  const back = Core.restoreMockItems(BANK, Core.snapshotMockItems(items));
  assert.equal(back.length, 100);
  back.forEach((q, i) => {
    assert.equal(q.id, items[i].id);
    assert.deepEqual(q.choices.map(c => c.id), items[i].choices.map(c => c.id));
  });
  assert.equal(Core.restoreMockItems(BANK, [{ id: "存在しないID", order: ["a"] }]), null);
  assert.equal(Core.restoreMockItems(BANK, []), null);
});

test("残り時間: 60分から減少し、負にならない", () => {
  const t0 = 1_000_000;
  assert.equal(Core.mockRemainingMs(t0, t0), 3600000);
  assert.equal(Core.mockRemainingMs(t0, t0 + 59 * 60000), 60000);
  assert.equal(Core.mockRemainingMs(t0, t0 + 61 * 60000), 0);
});

test("本試験の履歴・直近結果はバックアップに含まれ、進行中セッションは含まれない", () => {
  const mem = {}; const be = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  const st = Core.createStore(be);
  st.logMock({ at: 1, total: 100, correct: 85, rate: 85, passed: true });
  st.setMockLast({ entry: { at: 1 } });
  st.setMockSession({ v: 1, startedAt: 1 });
  const exp = Core.exportData(be);
  assert.ok(exp.data[Core.MOCK_KEYS.log]);
  assert.ok(exp.data[Core.MOCK_KEYS.last]);
  assert.equal(exp.data[Core.MOCK_KEYS.session], undefined);
  assert.equal(Core.validateBackup(exp), null);
  assert.match(Core.validateBackup({ app: Core.BACKUP_APP_ID, data: { [Core.MOCK_KEYS.log]: {} } }), /本試験/);
  st.clearMockSession();
  assert.equal(st.getMockSession(), null);
});

test("正解位置の偏りがない: 択一は各位置ちょうど20問、多肢の正解選択肢も均等に近い(200回試行)", () => {
  for (let t = 0; t < 200; t++) {
    const items = Core.buildMockExam(BANK, lcg(100 + t));
    const sp = [0, 0, 0, 0], mp = [0, 0, 0, 0, 0];
    items.forEach(q => q.choices.forEach((c, i) => {
      if (!q.answerIds.includes(c.id)) return;
      if (q.type === "multi") mp[i]++; else sp[i]++;
    }));
    assert.deepEqual(sp, [20, 20, 20, 20], "択一: " + sp);
    assert.ok(Math.max(...mp) - Math.min(...mp) <= 3, "多肢: " + mp);
  }
});

test("並びの調整後も、問題・選択肢の文言・正解の対応は変わらない", () => {
  const byId = Object.fromEntries(BANK.map(q => [q.id, q]));
  Core.buildMockExam(BANK, lcg(9)).forEach(q => {
    const raw = byId[q.id];
    const txt = (qq, ids) => ids.map(id => qq.choices.find(c => c.id === id).text).sort();
    assert.deepEqual(txt(q, q.answerIds), txt(raw, raw.answerIds));
    assert.deepEqual(q.choices.map(c => c.text).sort(), raw.choices.map(c => c.text).sort());
  });
});

test("問題バンクの登録順でも正解位置が特定の選択肢に偏らない", () => {
  const sp = [0, 0, 0, 0], mp = [0, 0, 0, 0, 0];
  BANK.forEach(q => q.choices.forEach((c, i) => {
    if (!q.answerIds.includes(c.id)) return;
    if (q.type === "multi") mp[i]++; else sp[i]++;
  }));
  assert.ok(Math.max(...sp) - Math.min(...sp) <= 2, "択一: " + sp);
  assert.ok(Math.max(...mp) - Math.min(...mp) <= 4, "多肢: " + mp);
});
