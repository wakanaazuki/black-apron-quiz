/* 本試験モードの結合テスト: 疑似DOM上で app.js を実際に動かす
 * 開始 → 解答 → 見直し → 提出 → 採点 / リロード再開 / 時間切れ自動提出 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = p => readFileSync(join(ROOT, p), "utf8");

function createEnv(storage = {}) {
  const store = Object.assign({}, storage);
  const handlers = { hashchange: [], click: [], keydown: [] };
  const screen = {
    innerHTML: "",
    classList: { add() {}, remove() {}, toggle() {} },
    offsetWidth: 0,
    contains: () => true,
    addEventListener: (t, f) => (handlers[t] = handlers[t] || []).push(f)
  };
  const ctx = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    location: { hash: "" },
    navigator: {},
    confirm: () => true,
    alert: () => {},
    scrollTo: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    document: {
      getElementById: id => (id === "screen" ? screen : null),
      querySelectorAll: () => [],
      addEventListener: (t, f) => (handlers[t] = handlers[t] || []).push(f),
      documentElement: { setAttribute() {}, getAttribute: () => "auto" },
      body: { appendChild() {}, removeChild() {} }
    },
    addEventListener: (t, f) => (handlers[t] = handlers[t] || []).push(f),
    console
  };
  ctx.window = ctx;
  ctx.confirmCalls = [];
  const origConfirm = ctx.confirm;
  ctx.confirm = (m) => { ctx.confirmCalls.push(m); return origConfirm(); };
  vm.createContext(ctx);
  const run = (code, name) => vm.runInContext(code, ctx, { filename: name });
  run("var QUESTION_DATA = [];", "init");
  for (const f of readdirSync(join(ROOT, "data", "questions")).sort()) run(read("data/questions/" + f), f);
  for (const f of ["data/coffees.js", "data/reference.js", "data/terms.js", "data/mock/bank.js", "core.js", "app.js"]) run(read(f), f);

  const go = hash => { ctx.location.hash = hash; handlers.hashchange.forEach(h => h()); };
  const click = (action, ds = {}) => {
    const el = {
      tagName: "BUTTON", dataset: ds,
      getAttribute: n => (n === "data-action" ? action : ds[n.replace("data-", "")] ?? null)
    };
    handlers.click.forEach(h => h({ target: { closest: () => el }, preventDefault() {} }));
  };
  return { ctx, store, screen, go, click };
}

const KEY = "blackApronQuiz.mockSession";

test("既存のホーム画面に本試験モードの入口が追加され、既存機能は残っている", () => {
  const e = createEnv();
  e.go("#/home");
  const h = e.screen.innerHTML;
  assert.match(h, /本試験モード/);
  assert.match(h, /模擬試験/);            // 既存の模擬試験(30問)
  assert.match(h, /フラッシュカード/);
  assert.match(h, /ランダム 10問/);
  assert.match(h, /間隔反復/);
});

test("メニュー → 開始: 第1問は第1部(4択)、タイマーと問題一覧が表示される", () => {
  const e = createEnv();
  e.go("#/mock");
  assert.match(e.screen.innerHTML, /本試験を開始/);
  assert.match(e.screen.innerHTML, /60分/);
  e.click("mock-start");
  const h = e.screen.innerHTML;
  assert.match(h, /第1問 \/ 100問/);
  assert.match(h, /第1部 択一選択\(4択\)/);
  assert.match(h, /残り 60:00|残り 59:5\d/);
  assert.equal((h.match(/data-action="mock-pick"/g) || []).length, 4);
  assert.equal((h.match(/data-action="mock-goto"/g) || []).length, 100);
  const sess = JSON.parse(e.store[KEY]);
  assert.equal(sess.items.length, 100);
});

test("解答 → 提出 → 完全一致採点(合格)。結果は履歴に保存され、進行中データは消える", () => {
  const e = createEnv();
  e.go("#/mock");
  e.click("mock-start");
  const sess = JSON.parse(e.store[KEY]);
  const bank = e.ctx.MOCK_BANK;
  const byId = Object.fromEntries(bank.map(q => [q.id, q]));

  let multiShown = false;
  sess.items.forEach((it, i) => {
    const q = byId[it.id];
    const correct = q.answerIds.slice();
    const wrong = q.choices.find(c => !q.answerIds.includes(c.id)).id;
    let pick;
    if (i < 5) pick = [wrong];                       // 択一5問ミス
    else if (i < 80) pick = correct;                 // 択一75問正解
    else if (i < 90) pick = correct;                 // 多肢10問 完全一致
    else if (i < 95) pick = correct.slice(1);        // 多肢5問 不足 → 不正解
    else pick = null;                                // 多肢5問 未解答
    // 画面は現在の問題の選択肢しか操作できないため、1問ずつ移動して選ぶ
    if (e.screen.innerHTML.indexOf("第" + (i + 1) + "問 / 100問") < 0) throw new Error("画面と進行がずれている: " + i);
    if (i >= 80 && !multiShown) {
      multiShown = true;
      assert.match(e.screen.innerHTML, /第2部 多肢選択\(5択・正解複数\)/);
      assert.equal((e.screen.innerHTML.match(/data-action="mock-pick"/g) || []).length, 5);
      assert.match(e.screen.innerHTML, /過不足なく一致した場合のみ正解/);
    }
    if (pick) pick.forEach(cid => e.click("mock-pick", { cid }));
    if (i < 99) e.click("mock-next");
  });

  e.click("mock-submit");
  assert.equal(e.ctx.confirmCalls.length, 1);
  assert.match(e.ctx.confirmCalls[0], /未解答: 5問/);

  const h = e.screen.innerHTML;
  // 75 + 10 = 85問正解
  assert.match(h, /85<small> \/ 100/);
  assert.match(h, /合格/);
  assert.match(h, /第1部 択一\(4択\)<\/span><span>75 \/ 80問/);
  assert.match(h, /第2部 多肢\(5択\)<\/span><span>10 \/ 20問/);
  assert.match(h, /未解答<\/span><span>5問/);

  assert.equal(e.store[KEY], undefined, "進行中データは提出後に消える");
  const log = JSON.parse(e.store["blackApronQuiz.mockLog"]);
  assert.equal(log.length, 1);
  assert.equal(log[0].correct, 85);
  assert.equal(log[0].passed, true);
  assert.ok(JSON.parse(e.store["blackApronQuiz.mockLast"]).items.length === 100);

  // 結果画面から解説を確認: 不正解・未解答 15問が既定で表示される
  assert.equal((h.match(/class="card mock-review"/g) || []).length, 15);
  e.click("mock-review-toggle");
  assert.equal((e.screen.innerHTML.match(/class="card mock-review"/g) || []).length, 100);
});

test("リロード後も進行中の試験を再開でき、解答・見直しフラグ・時刻が保持される", () => {
  const e1 = createEnv();
  e1.go("#/mock");
  e1.click("mock-start");
  const cid = JSON.parse(e1.store[KEY]).items[0].order[0];
  e1.click("mock-pick", { cid });
  e1.click("mock-flag");
  e1.click("mock-goto", { i: "37" });

  const e2 = createEnv(e1.store);      // 同じlocalStorageで再起動
  e2.go("#/mock");
  const h = e2.screen.innerHTML;
  assert.match(h, /第38問 \/ 100問/);
  assert.match(h, /解答済 1 \/ 100/);
  assert.match(h, /class="mock-cell done flag"/);
  // ホームには受験中バッジ
  e2.go("#/home");
  assert.match(e2.screen.innerHTML, /受験中/);
});

test("制限時間(60分)を過ぎて開くと自動提出され、結果が表示される", () => {
  const e1 = createEnv();
  e1.go("#/mock");
  e1.click("mock-start");
  const sess = JSON.parse(e1.store[KEY]);
  sess.startedAt = Date.now() - 61 * 60000;
  e1.store[KEY] = JSON.stringify(sess);

  const e2 = createEnv(e1.store);
  e2.go("#/mock");
  const h = e2.screen.innerHTML;
  assert.match(h, /制限時間により自動提出されました/);
  assert.match(h, /不合格/);
  assert.match(h, /未解答<\/span><span>100問/);
  assert.equal(e2.store[KEY], undefined);
  assert.equal(JSON.parse(e2.store["blackApronQuiz.mockLog"])[0].timeUp, true);
});

test("択一は再タップで解除でき、多肢は複数選択できる", () => {
  const e = createEnv();
  e.go("#/mock");
  e.click("mock-start");
  const s0 = () => JSON.parse(e.store[KEY]);
  const order = s0().items[0].order;
  e.click("mock-pick", { cid: order[0] });
  e.click("mock-pick", { cid: order[1] });          // 択一: 置き換わる
  assert.deepEqual(s0().answers[s0().items[0].id], [order[1]]);
  e.click("mock-pick", { cid: order[1] });          // 再タップで解除
  assert.equal(s0().answers[s0().items[0].id], undefined);

  e.click("mock-goto", { i: "80" });                // 第2部へ
  const mo = s0().items[80].order;
  e.click("mock-pick", { cid: mo[0] });
  e.click("mock-pick", { cid: mo[2] });
  assert.deepEqual(s0().answers[s0().items[80].id].sort(), [mo[0], mo[2]].sort());
});
