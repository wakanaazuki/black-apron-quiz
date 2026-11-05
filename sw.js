/* ブラックエプロン試験クイズ - Service Worker (オフライン対応)
 * 自己完結版 index.html 用。画面・プログラム・問題データはすべて index.html に含まれるため、
 * キャッシュするのはシェル(index.html・manifest・アイコン)だけです。
 * CACHE_NAME を変えると、古いキャッシュ(旧版の app.js / data など)が自動で削除され、画面も自動で再読み込みされます。 */
const CACHE_NAME = "be-quiz-v5-single";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // 一部が無くても(例: アイコン未アップロード)インストールが失敗しないよう個別に追加
      .then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ページ本体(index.html)はネットワーク優先 → 更新が反映されやすい。失敗時(オフライン)はキャッシュ */
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const isPage = e.request.mode === "navigate";
  e.respondWith(
    (isPage
      ? fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put("./index.html", copy));
          return res;
        }).catch(() => caches.match("./index.html"))
      : caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
          return res;
        }))
    )
  );
});
