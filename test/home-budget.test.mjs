// node --test test/*.test.mjs
// A Home whose server or TMDB lists never answer is cut at the budget and shows what loaded.
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
let clock = 0;
const results = Array.from({ length: 6 }, (_, i) => ({ id: 10 + i, title: "T" + i, name: "T" + i, release_date: "2024-01-01", first_air_date: "2024-01-01", poster_path: "/p.jpg", genre_ids: [] }));
globalThis.kino = {
  lang: "es",
  config: { get: () => undefined },
  storage: { get: (k) => (store.has(k) ? store.get(k) : null), set: (k, v) => { store.set(k, v); }, remove: (k) => { store.delete(k); }, keys: () => [...store.keys()] },
  fetch: () => new Promise(() => {}), // the server never answers
  tmdb: (path) => {
    if (path.startsWith("/genre/") || path.startsWith("/movie/")) return Promise.resolve(path.startsWith("/genre/") ? { genres: [] } : { results });
    if (path.startsWith("/trending/movie")) return Promise.resolve({ results });
    return new Promise(() => {}); // every tv list hangs
  },
  sleep: async () => { clock += 1; await new Promise((r) => setImmediate(r)); }, // one shared timeline, a tick per wait
  log() {}, meta: async () => null, rank: {},
  error: (code, message, opts = {}) => Object.assign(new Error(message), { code, ...opts }),
};
const realNow = Date.now;
const plugin = await import("../plugin.js");

test("the plugin asks Kino to drop the requests a call leaves running", () => {
  assert.equal(globalThis.__kinoDropPendingFetches, true);
});

// first: the lists the next test lets load are kept in memory for a while
test("when nothing loads the Home says so instead of hanging", async () => {
  clock = 0;
  Date.now = () => 1e12 + clock;
  const tmdb = kino.tmdb;
  kino.tmdb = (path) => (path.startsWith("/genre/") ? Promise.resolve({ genres: [] }) : new Promise(() => {}));
  try {
    await assert.rejects(() => plugin.home(), (e) => e.code === "unavailable");
  } finally { Date.now = realNow; kino.tmdb = tmdb; }
});

test("home shows the lists that loaded and leaves off the live row and the lists that never answer", async () => {
  clock = 0;
  Date.now = () => 1e12 + clock;
  try {
    const rows = await plugin.home();
    assert.ok(rows.length >= 1 && rows.length < 4, "rows: " + rows.length);
    assert.ok(clock <= 16000, "gave up at the budget, clock " + clock);
  } finally { Date.now = realNow; }
});
