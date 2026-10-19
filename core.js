/**
 * core.js — ブラックエプロン試験クイズの純粋ロジック層
 *
 * DOM/localStorageに直接依存しない関数群。
 * ブラウザでは classic script として `window.Core`、
 * Nodeでは `globalThis.Core` として利用できる(node:testで検証)。
 */
(function (g) {
  "use strict";

  var DAY_MS = 86400000;
  var SCHEMA_VERSION = 2;
  var ATTEMPTS_MAX = 3000;
  var REVIEW_CLEAR_STREAK = 3; // 復習対象から外れる連続正解数

  /* ================= テキスト正規化(表記ゆれ吸収) ================= */
  /** ®™・中黒・全半角・空白差を吸収する比較用文字列を返す */
  function normText(s) {
    return String(s == null ? "" : s)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[®™]/g, "")
      .replace(/[・･⋅]/g, "")
      .replace(/\s+/g, "");
  }

  /* ================= 問題の正規化 ================= */
  /**
   * 新形式 { choices:[{id,text}], answerIds:[id,...] } と
   * 旧形式 { choices:[str,...], answer:index } の両方を
   * 新形式に正規化する。
   */
  function normalizeQuestion(q) {
    var base = {
      type: "single",
      explanation: "",
      sources: [],
      difficulty: 2,
      tags: []
    };
    for (var k in q) base[k] = q[k];

    if (Array.isArray(q.choices) && typeof q.choices[0] === "string") {
      var letters = "abcdefgh";
      base.choices = q.choices.map(function (t, i) {
        return { id: letters[i], text: t };
      });
      base.answerIds = [letters[q.answer]];
    }
    if (base.answerIds.length > 1) base.type = "multi";
    if (!base.type) base.type = "single";
    return base;
  }

  /** 出題用に選択肢をシャッフルした出題オブジェクトを作る */
  function prepareQuestion(rawQ, rng) {
    var nq = normalizeQuestion(rawQ);
    nq.choices = shuffle(nq.choices, rng);
    return nq;
  }

  /** Fisher-Yatesシャッフル(rng差し替え可能でテスト容易) */
  function shuffle(arr, rng) {
    var a = arr.slice();
    var rand = rng || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * 採点。正規化済み問題と選択肢ID配列(回答)を受け取る。
   * 単一選択・複数選択とも「選択肢ID集合の完全一致」で判定。
   */
  function judge(nq, pickedIds) {
    if (!Array.isArray(pickedIds) || pickedIds.length === 0) return false;
    var a = nq.answerIds.slice().sort().join("|");
    var p = pickedIds.slice().sort().join("|");
    return a === p;
  }

  /* ================= 間隔反復(SM-2系) ================= */
  /**
   * SM-2簡易版。quality: 0〜5(正解=4, 不正解=1として呼ぶ)。
   * card: {easeFactor, intervalDays, repetitions, dueAt, lapses}
   */
  function sm2Next(card, quality, now) {
    now = now == null ? Date.now() : now;
    var ef = card && card.easeFactor || 2.5;
    var reps = card && card.repetitions || 0;
    var iv = card && card.intervalDays || 0;
    var lapses = card && card.lapses || 0;

    if (quality < 3) {
      lapses += 1;
      reps = 0;
      iv = 0.02; // 約30分後に再出題
    } else {
      reps += 1;
      iv = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(iv * ef);
      ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
      if (ef < 1.3) ef = 1.3;
    }
    return {
      easeFactor: Math.round(ef * 100) / 100,
      intervalDays: iv,
      repetitions: reps,
      lapses: lapses,
      dueAt: now + iv * DAY_MS
    };
  }

  /* ================= 永続化層 ================= */
  /**
   * localStorage互換のバックエンド(getItem/setItem)を注入して使う。
   * 既存キー blackApronQuiz.wrongIds / .stats は維持。
   * wrongIds は v1 の配列形式から v2 の {id:{misses,streak}} へ無損失マイグレーション。
   */
  var KEYS = {
    wrong: "blackApronQuiz.wrongIds",
    stats: "blackApronQuiz.stats",
    attempts: "blackApronQuiz.attempts",
    srs: "blackApronQuiz.srs",
    examLog: "blackApronQuiz.examLog",
    version: "blackApronQuiz.schemaVersion"
  };
  /* 本試験モード用キー(mockSession は進行中データのためバックアップ対象外) */
  var MOCK_KEYS = {
    log: "blackApronQuiz.mockLog",
    last: "blackApronQuiz.mockLast",
    session: "blackApronQuiz.mockSession"
  };

  function createStore(backend) {
    function read(key, fallback) {
      try {
        var v = backend.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    }
    function write(key, val) {
      backend.setItem(key, JSON.stringify(val));
    }

    var store = {
      backend: backend,

      /* ---- マイグレーション(起動時に1回) ---- */
      migrate: function () {
        var v = read(KEYS.version, 1);
        if (v < 2) {
          // wrongIds: array → {id:{misses,streak}}
          var old = read(KEYS.wrong, []);
          if (Array.isArray(old)) {
            var map = {};
            old.forEach(function (id) { map[id] = { misses: 1, streak: 0 }; });
            write(KEYS.wrong, map);
          }
          write(KEYS.version, 2);
        }
      },

      /* ---- 復習リスト(3回連続正解で解除) ---- */
      getWrongMap: function () {
        var m = read(KEYS.wrong, {});
        return Array.isArray(m) ? {} : m; // 未マイグレーション時の保険
      },
      wrongIds: function () { return Object.keys(this.getWrongMap()); },
      recordOutcome: function (qid, isCorrect) {
        var m = this.getWrongMap();
        var e = m[qid] || { misses: 0, streak: 0 };
        if (isCorrect) {
          e.streak += 1;
          if (e.streak >= REVIEW_CLEAR_STREAK) delete m[qid];
          else m[qid] = e;
        } else {
          e.misses += 1;
          e.streak = 0;
          m[qid] = e;
        }
        write(KEYS.wrong, m);
      },

      /* ---- 累計統計(既存キー) ---- */
      getStats: function () {
        return read(KEYS.stats, { answered: 0, correct: 0 });
      },
      bumpStats: function (isCorrect) {
        var s = this.getStats();
        s.answered += 1;
        if (isCorrect) s.correct += 1;
        write(KEYS.stats, s);
      },

      /* ---- 回答履歴(直近3000件ローテーション) ---- */
      getAttempts: function () { return read(KEYS.attempts, []); },
      logAttempt: function (entry) {
        var a = this.getAttempts();
        a.push(entry);
        if (a.length > ATTEMPTS_MAX) a = a.slice(a.length - ATTEMPTS_MAX);
        write(KEYS.attempts, a);
      },

      /* ---- SRS ---- */
      getSrs: function () { return read(KEYS.srs, {}); },
      updateSrs: function (qid, quality, now) {
        var s = this.getSrs();
        s[qid] = sm2Next(s[qid], quality, now);
        write(KEYS.srs, s);
      },
      dueIds: function (now) {
        now = now == null ? Date.now() : now;
        var s = this.getSrs();
        return Object.keys(s).filter(function (id) { return s[id].dueAt <= now; });
      },

      /* ---- 模擬試験履歴 ---- */
      getExamLog: function () { return read(KEYS.examLog, []); },
      logExam: function (entry) {
        var a = this.getExamLog();
        a.push(entry);
        write(KEYS.examLog, a);
      },

      /* ---- 本試験モード(60分・100問) ---- */
      getMockLog: function () { return read(MOCK_KEYS.log, []); },
      logMock: function (entry) {
        var a = this.getMockLog();
        a.push(entry);
        write(MOCK_KEYS.log, a);
      },
      getMockLast: function () { return read(MOCK_KEYS.last, null) || null; },
      setMockLast: function (v) { write(MOCK_KEYS.last, v); },
      getMockSession: function () { return read(MOCK_KEYS.session, null) || null; },
      setMockSession: function (v) { write(MOCK_KEYS.session, v); },
      clearMockSession: function () {
        if (typeof backend.removeItem === "function") backend.removeItem(MOCK_KEYS.session);
        else write(MOCK_KEYS.session, null);
      }
    };
    return store;
  }

  /* ================= バックアップ(エクスポート/インポート) ================= */
  var BACKUP_APP_ID = "blackApronQuiz";
  var EXTRA_KEYS = ["blackApronQuiz.theme", "blackApronQuiz.lastBackupAt"];
  var EXPORT_KEYS = Object.keys(KEYS).map(function (k) { return KEYS[k]; })
    .concat(EXTRA_KEYS)
    .concat([MOCK_KEYS.log, MOCK_KEYS.last]);

  /** localStorageの学習データをまとめたバックアップオブジェクトを返す */
  function exportData(backend) {
    var data = {};
    EXPORT_KEYS.forEach(function (key) {
      var raw;
      try { raw = backend.getItem(key); } catch (e) { raw = null; }
      if (raw != null) {
        try { data[key] = JSON.parse(raw); } catch (e) { data[key] = raw; }
      }
    });
    return {
      app: BACKUP_APP_ID,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      data: data
    };
  }

  /**
   * インポート対象JSONの検証。問題なければnull、問題があれば理由の文字列を返す。
   * 壊れたファイルで既存データを上書きしないためのガード。
   */
  function validateBackup(obj) {
    if (!obj || typeof obj !== "object") return "JSONオブジェクトではありません";
    if (obj.app !== BACKUP_APP_ID) return "このアプリのバックアップではありません";
    if (!obj.data || typeof obj.data !== "object" || Array.isArray(obj.data))
      return "バックアップのデータ部が不正です";
    var wrong = obj.data[KEYS.wrong];
    if (wrong != null && (typeof wrong !== "object" || wrong == null))
      return "復習データの形式が不正です";
    var stats = obj.data[KEYS.stats];
    if (stats != null && (typeof stats !== "object" ||
        typeof stats.answered !== "number" || typeof stats.correct !== "number"))
      return "統計データの形式が不正です";
    var attempts = obj.data[KEYS.attempts];
    if (attempts != null && !Array.isArray(attempts)) return "履歴データの形式が不正です";
    var mlog = obj.data[MOCK_KEYS.log];
    if (mlog != null && !Array.isArray(mlog)) return "本試験の履歴データの形式が不正です";
    var srs = obj.data[KEYS.srs];
    if (srs != null && (typeof srs !== "object" || Array.isArray(srs)))
      return "SRSデータの形式が不正です";
    return null;
  }

  /** 検証済みバックアップをバックエンドへ書き戻す。validateBackupを通してから呼ぶこと */
  function importData(backend, obj) {
    var err = validateBackup(obj);
    if (err) return err;
    Object.keys(obj.data).forEach(function (key) {
      backend.setItem(key, JSON.stringify(obj.data[key]));
    });
    return null;
  }

  /* ================= 本試験モード(60分・100問) ================= */
  var MOCK_SINGLE_COUNT = 80;      // 択一選択(4択)
  var MOCK_MULTI_COUNT = 20;       // 多肢選択(5択・正解複数)
  var MOCK_DURATION_MS = 60 * 60 * 1000;
  var MOCK_PASS_RATE = 80;         // 合格ライン(%)。資料に記載がないため既存の模擬試験と同じ値を採用

  /**
   * 問題バンクから「4択80問 + 5択20問」の試験を組む。
   * 前半=択一選択80問、後半=多肢選択20問。各設問の選択肢は出題ごとにシャッフル。
   * 条件を満たす問題が足りない場合は Error を投げる。
   */
  function buildMockExam(bank, rng) {
    var singles = bank.filter(function (q) {
      var n = normalizeQuestion(q);
      return n.type !== "multi" && n.choices.length === 4 && n.answerIds.length === 1;
    });
    var multis = bank.filter(function (q) {
      var n = normalizeQuestion(q);
      return n.type === "multi" && n.choices.length === 5 && n.answerIds.length >= 2;
    });
    if (singles.length < MOCK_SINGLE_COUNT)
      throw new Error("択一(4択)の問題が不足しています: " + singles.length + "/" + MOCK_SINGLE_COUNT);
    if (multis.length < MOCK_MULTI_COUNT)
      throw new Error("多肢選択(5択)の問題が不足しています: " + multis.length + "/" + MOCK_MULTI_COUNT);
    var pick = function (arr, n) {
      return shuffle(arr, rng).slice(0, n).map(function (q) { return prepareQuestion(q, rng); });
    };
    var exam = balanceMockPositions(
      pick(singles, MOCK_SINGLE_COUNT).concat(pick(multis, MOCK_MULTI_COUNT)), rng);
    return exam;
  }

  /**
   * 正解位置の偏りをなくす。
   *  - 択一(4択): 正解の位置(A〜D)が各 N/4 問になるよう割り当てる(80問なら各20問)。
   *  - 多肢(5択): 各位置に入る「正解選択肢」の数が均等に近づくよう、候補シャッフルから選ぶ。
   * 出題内容(どの問題か)や選択肢の文言は変えず、並びだけを調整する。
   */
  function balanceMockPositions(items, rng) {
    var rand = rng || Math.random;
    var singles = items.filter(function (q) { return q.type !== "multi"; });
    var slots = [];
    for (var i = 0; i < singles.length; i++) slots.push(i % 4);
    slots = shuffle(slots, rng);
    singles.forEach(function (q, k) {
      var cur = -1;
      for (var j = 0; j < q.choices.length; j++) if (q.answerIds.indexOf(q.choices[j].id) >= 0) cur = j;
      var t = slots[k];
      if (cur >= 0 && t < q.choices.length && cur !== t) {
        var tmp = q.choices[t]; q.choices[t] = q.choices[cur]; q.choices[cur] = tmp;
      }
    });
    var counts = [0, 0, 0, 0, 0];
    items.filter(function (q) { return q.type === "multi"; }).forEach(function (q) {
      var best = null, bestScore = Infinity;
      for (var tries = 0; tries < 16; tries++) {
        var cand = shuffle(q.choices, rand);
        var score = 0;
        cand.forEach(function (c, pos) { if (q.answerIds.indexOf(c.id) >= 0) score += counts[pos] * counts[pos] + counts[pos]; });
        if (score < bestScore) { bestScore = score; best = cand; }
      }
      q.choices = best;
      best.forEach(function (c, pos) { if (q.answerIds.indexOf(c.id) >= 0) counts[pos]++; });
    });
    return items;
  }

  /** 進行中の試験を保存用に軽量化({id, order:[選択肢ID...]}) */
  function snapshotMockItems(items) {
    return items.map(function (q) {
      return { id: q.id, order: q.choices.map(function (c) { return c.id; }) };
    });
  }

  /** snapshotMockItems の逆変換。バンクに存在しないIDがあれば null を返す */
  function restoreMockItems(bank, snap) {
    if (!Array.isArray(snap) || !snap.length) return null;
    var byId = {};
    bank.forEach(function (q) { byId[q.id] = q; });
    var out = [];
    for (var i = 0; i < snap.length; i++) {
      var raw = byId[snap[i].id];
      if (!raw) return null;
      var nq = normalizeQuestion(raw);
      var map = {};
      nq.choices.forEach(function (c) { map[c.id] = c; });
      var ordered = [];
      for (var j = 0; j < snap[i].order.length; j++) {
        if (!map[snap[i].order[j]]) return null;
        ordered.push(map[snap[i].order[j]]);
      }
      nq.choices = ordered;
      out.push(nq);
    }
    return out;
  }

  /** 残り時間(ms)。負にはならない */
  function mockRemainingMs(startedAt, now, durationMs) {
    var d = durationMs == null ? MOCK_DURATION_MS : durationMs;
    return Math.max(0, startedAt + d - now);
  }

  /**
   * 採点。answers: { 問題ID: [選択肢ID,...] }。
   * 択一・多肢とも「選択肢ID集合の完全一致」のみ正解(部分点なし)、未回答は不正解。
   */
  function scoreMock(items, answers, passRate) {
    var pr = passRate == null ? MOCK_PASS_RATE : passRate;
    var res = {
      total: items.length, correct: 0, unanswered: 0,
      single: { total: 0, correct: 0 }, multi: { total: 0, correct: 0 },
      details: []
    };
    items.forEach(function (q) {
      var picked = (answers && answers[q.id]) || [];
      var answered = picked.length > 0;
      var ok = judge(q, picked);
      var sec = q.type === "multi" ? res.multi : res.single;
      sec.total++;
      if (ok) { sec.correct++; res.correct++; }
      if (!answered) res.unanswered++;
      res.details.push({ id: q.id, type: q.type, answered: answered, isCorrect: ok, picked: picked.slice() });
    });
    res.rate = res.total ? Math.round((res.correct / res.total) * 1000) / 10 : 0;
    res.passRate = pr;
    res.passed = res.total > 0 && res.rate >= pr;
    return res;
  }

  /* ================= 公開 ================= */
  g.Core = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    REVIEW_CLEAR_STREAK: REVIEW_CLEAR_STREAK,
    KEYS: KEYS,
    normText: normText,
    normalizeQuestion: normalizeQuestion,
    prepareQuestion: prepareQuestion,
    shuffle: shuffle,
    judge: judge,
    MOCK_KEYS: MOCK_KEYS,
    MOCK_SINGLE_COUNT: MOCK_SINGLE_COUNT,
    MOCK_MULTI_COUNT: MOCK_MULTI_COUNT,
    MOCK_DURATION_MS: MOCK_DURATION_MS,
    MOCK_PASS_RATE: MOCK_PASS_RATE,
    buildMockExam: buildMockExam,
    balanceMockPositions: balanceMockPositions,
    snapshotMockItems: snapshotMockItems,
    restoreMockItems: restoreMockItems,
    mockRemainingMs: mockRemainingMs,
    scoreMock: scoreMock,
    sm2Next: sm2Next,
    createStore: createStore,
    BACKUP_APP_ID: BACKUP_APP_ID,
    EXPORT_KEYS: EXPORT_KEYS,
    exportData: exportData,
    validateBackup: validateBackup,
    importData: importData
  };
})(typeof window !== "undefined" ? window : globalThis);
