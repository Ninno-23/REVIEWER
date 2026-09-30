/**
 * StudyVault service worker — built for years of local use.
 * Cache-first shell so the family study space keeps working offline
 * even if nobody touches the files for a long time. Soft-revalidates
 * when the network is available so a newer shell can land without drama.
 */
const CACHE_NAME = "studyvault-v154-0-shell";
const REMOTE_CACHE = "studyvault-v154-0-runtime";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./ai-worker.js",
  "./manifest.json",
  "./icon.svg",
  "./version.json",
  "./vendor/pdfjs/pdf.min.js",
  "./vendor/pdfjs/pdf.worker.min.js",
  "./vendor/tesseract/tesseract.min.js",
  "./vendor/jszip/jszip.min.js"
];

const ALLOWED_REMOTE = [
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "api.qrserver.com",
  "tessdata.projectnaptha.com",
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cas-bridge.xethub.hf.co",
  "en.wikipedia.org",
  "upload.wikimedia.org",
  "thumb.wikimedia.org",
  "commons.wikimedia.org",
  "wikimedia.org",
  "image.pollinations.ai",
  "pollinations.ai",
  "gen.pollinations.ai",
  "api.duckduckgo.com",
  "duckduckgo.com"
];

function isAllowedRemote(url) {
  return ALLOWED_REMOTE.some(
    (host) => url.hostname === host || url.hostname.endsWith("." + host)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((c) =>
        c.addAll(SHELL).catch((err) => {
          console.warn("Shell cache partial (vendor may be missing once)", err);
          return c.addAll(SHELL.filter((p) => !p.includes("/vendor/")));
        })
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== REMOTE_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/** Cache-first for same-origin app + vendor — keeps the shell alive offline for years. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Soft revalidate in background when online so a 2-year-old install can still pick up a new shell
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          caches.open(CACHE_NAME).then((c) => c.put(request, res.clone())).catch(() => {});
        }
      })
      .catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      caches.open(CACHE_NAME).then((c) => c.put(request, res.clone())).catch(() => {});
    }
    return res;
  } catch {
    if (request.mode === "navigate") return caches.match("./index.html");
    return new Response("Offline and this piece is not cached yet. Open StudyVault once while online to seed the shell.", {
      status: 503,
      statusText: "Offline"
    });
  }
}

async function remoteRuntime(request) {
  const cache = await caches.open(REMOTE_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request)
      .then((res) => {
        if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
      })
      .catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch {
    return (
      cached ||
      new Response("", { status: 503, statusText: "Offline and resource is not cached" })
    );
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  if (isAllowedRemote(url)) event.respondWith(remoteRuntime(event.request));
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
