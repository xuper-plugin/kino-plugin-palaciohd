// @ts-check
/// <reference path="./kino.d.ts" />
// Palacio HD: a bridge between Kino and a Stremio-protocol server. The server has no catalog of movies and series, only
// the video for a title by its IMDb id, plus a live TV catalog; the titles come from Kino's own TMDB access (kino.tmdb,
// kino.meta) and the video from the server. The server owns the sources and their upkeep; this file knows nothing about
// any of them and reads the live TV catalog and its genres from the server's manifest on every run.
// Read it top to bottom: 1. texts  2. http  3. manifest  4. TMDB  5. titles  6. rows  7. streams  8. live  9. settings

const BASE = "https://hd.plavio.site";

// ---- 1. texts ----------------------------------------------------------------------------------------------------

const TEXTS = {
  es: {
    timeout: "El servidor tardó demasiado. Inténtalo de nuevo.",
    warming: "El servidor está preparando las fuentes de este título. Inténtalo de nuevo en unos segundos.",
    network: "No se pudo conectar con el servidor.",
    server: "El servidor respondió {status}.",
    notStremio: "El servidor no respondió con el formato esperado.",
    noStreams: "Este título no tiene fuentes disponibles ahora.",
    noChannel: "Este canal no está disponible ahora.",
    drmOnly: "Esto solo se ofrece con una protección que este reproductor no admite.",
    noTmdb: "No se pudo consultar el catálogo de títulos. Revisa tu conexión.",
    noImdb: "Este título no tiene el identificador que usa el servidor.",
    noEpisodes: "No se encontraron episodios para esta serie.",
    unknownRef: "Referencia desconocida.",
    ok: "Conectado. Catálogo de títulos, fuentes y TV en vivo comprobados.",
    stepManifest: "No se pudo leer el manifiesto del servidor: {detail}",
    stepTitles: "No se pudo consultar el catálogo de títulos: {detail}",
    stepStream: "Falló pedir las fuentes de un título: {detail}",
    stepLive: "Fallaron los canales en vivo: {detail}",
    offline: "Sin conexión: {detail}",
    online: "Conectado: {channels} canales en vivo",
    cinema: "Cine",
    series: "Series",
    live: "En vivo",
    trending: "Tendencias",
    popular: "Populares",
    topRated: "Mejor valoradas",
    nowPlaying: "En cartelera",
    onAir: "Al aire ahora",
  },
  en: {
    timeout: "The server took too long. Try again.",
    warming: "The server is preparing this title's sources. Try again in a few seconds.",
    network: "Could not reach the server.",
    server: "The server answered {status}.",
    notStremio: "The server did not answer in the expected format.",
    noStreams: "This title has no sources available right now.",
    noChannel: "This channel is not available right now.",
    drmOnly: "This is only offered with a protection this player does not support.",
    noTmdb: "Could not reach the title catalog. Check your connection.",
    noImdb: "This title has no identifier the server uses.",
    noEpisodes: "No episodes were found for this series.",
    unknownRef: "Unknown reference.",
    ok: "Connected. Title catalog, sources and live TV checked.",
    stepManifest: "Could not read the server's manifest: {detail}",
    stepTitles: "Could not reach the title catalog: {detail}",
    stepStream: "Asking a title's sources failed: {detail}",
    stepLive: "Live channels failed: {detail}",
    offline: "Offline: {detail}",
    online: "Connected: {channels} live channels",
    cinema: "Movies",
    series: "Series",
    live: "Live",
    trending: "Trending",
    popular: "Popular",
    topRated: "Top rated",
    nowPlaying: "In theaters",
    onAir: "On the air",
  },
};

function t(key, vars) {
  const lang = String(kino.lang || "").toLowerCase().startsWith("es") ? "es" : "en";
  const tpl = TEXTS[lang][key] || TEXTS.es[key] || key;
  return vars ? tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] != null ? vars[k] : "")) : tpl;
}

// ---- 2. http -----------------------------------------------------------------------------------------------------

function enc(s) {
  return encodeURIComponent(String(s));
}

/** The first two segments of a path ("/stream/movie"): enough to tell what failed, never an id. */
function route(path) {
  return path.split("/").slice(0, 3).join("/");
}

async function getJson(path, timeoutMs, onTimeout) {
  let r;
  try {
    r = await kino.fetch(BASE + path, { timeoutMs: timeoutMs || 12000 });
  } catch (e) {
    const code = e && e.code;
    kino.log("fetch " + route(path) + " failed: " + code);
    throw kino.error("unavailable", "fetch " + code, { userMessage: t(code === "timeout" ? onTimeout || "timeout" : "network") });
  }
  if (!r.ok) {
    kino.log("fetch " + route(path) + " answered " + r.status);
    throw kino.error(r.status === 404 ? "not_found" : "unavailable", "http " + r.status, { userMessage: t("server", { status: r.status }) });
  }
  try {
    return r.json();
  } catch {
    kino.log("fetch " + route(path) + " is not json");
    throw kino.error("unavailable", "not json", { userMessage: t("notStremio") });
  }
}

/** Runs `fn` over `list` with at most `limit` in flight; a failed item answers undefined. */
async function pool(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try { out[i] = await fn(list[i], i); } catch { out[i] = undefined; }
    }
  };
  const workers = [];
  for (let w = 0; w < Math.min(limit, list.length); w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

const MEM = new Map();
const TTL_PAGE = 10 * 60 * 1000;

async function cachedMem(key, ttl, fn) {
  const hit = MEM.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = await fn();
  MEM.set(key, { at: Date.now(), v });
  return v;
}

/** A value kept in storage for `ttl` ms; `make` runs when it is missing or stale, and a failure keeps nothing. */
async function stored(key, ttl, make) {
  try {
    const raw = kino.storage.get(key);
    if (raw) {
      const e = JSON.parse(raw);
      if (e && typeof e.at === "number" && Date.now() - e.at < ttl) return e.v;
    }
  } catch { /* unreadable: ask again */ }
  const v = await make();
  try { kino.storage.set(key, JSON.stringify({ at: Date.now(), v })); } catch { /* storage full: not cached */ }
  return v;
}

// ---- 3. manifest -------------------------------------------------------------------------------------------------

const TTL_MANIFEST = 60 * 60 * 1000;

function isLiveType(type) {
  return type === "tv" || type === "channel";
}

function normalizeManifest(m) {
  if (!m || typeof m !== "object" || !Array.isArray(m.catalogs)) throw kino.error("unavailable", "no catalogs", { userMessage: t("notStremio") });
  const catalogs = [];
  for (const c of m.catalogs) {
    if (!c || !c.id || !c.type || !isLiveType(String(c.type))) continue;
    const extra = Array.isArray(c.extra) ? c.extra : [];
    const required = extra.filter((e) => e && e.isRequired).map((e) => e.name);
    const genreExtra = extra.find((e) => e && e.name === "genre");
    catalogs.push({
      id: String(c.id),
      type: String(c.type),
      name: String(c.name || c.id),
      search: extra.some((e) => e && e.name === "search"),
      genres: Array.isArray(genreExtra && genreExtra.options) ? genreExtra.options.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim().slice(0, 60)).slice(0, 30) : [],
      browsable: required.every((n) => n === "genre"),
    });
  }
  const resources = (m.resources || []).map((r) => (typeof r === "string" ? r : r && r.name)).filter(Boolean);
  return { catalogs: catalogs.filter((c) => c.browsable), resources };
}

async function loadManifest(fresh) {
  const make = async () => normalizeManifest(await getJson("/manifest.json", 15000));
  if (fresh) return make();
  try {
    return await stored("m1", TTL_MANIFEST, make);
  } catch (e) {
    try {
      const stale = JSON.parse(kino.storage.get("m1") || "null");
      if (stale && stale.v) return stale.v; // the server hiccuped: the last manifest still works
    } catch { /* nothing kept */ }
    throw e;
  }
}

// ---- 4. TMDB -----------------------------------------------------------------------------------------------------

function tmdbLang() {
  return String(kino.lang || "").toLowerCase().startsWith("es") ? "es-MX" : "en-US";
}

// Kino answers a plugin at most 20 TMDB calls per 10 s on its own key (more only on the person's), and Home, the section
// and Categorías are asked together when the app opens. Every call takes a slot here, so the burst waits its turn
// instead of being refused.
const TMDB_WINDOW_MS = 10000;
const TMDB_MAX_IN_WINDOW = 16;
const TMDB_CALLS = [];

async function tmdbSlot() {
  for (;;) {
    const now = Date.now();
    while (TMDB_CALLS.length && now - TMDB_CALLS[0] >= TMDB_WINDOW_MS) TMDB_CALLS.shift();
    if (TMDB_CALLS.length < TMDB_MAX_IN_WINDOW) {
      TMDB_CALLS.push(now);
      return;
    }
    await kino.sleep(Math.min(5000, TMDB_WINDOW_MS - (now - TMDB_CALLS[0]) + 50));
  }
}

/** A GET to TMDB through Kino (no key here): cached in memory for the sandbox's life. */
async function tmdb(path, params) {
  if (typeof kino.tmdb !== "function") throw kino.error("unavailable", "no kino.tmdb", { userMessage: t("noTmdb") });
  const query = Object.assign({ language: tmdbLang() }, params || {});
  try {
    return await cachedMem(path + "?" + JSON.stringify(query), TTL_PAGE, async () => {
      await tmdbSlot();
      return kino.tmdb(path, query);
    });
  } catch (e) {
    const code = e && e.code;
    kino.log("tmdb " + path.split("/").slice(0, 3).join("/") + " failed: " + code);
    if (code === "not_found") throw kino.error("not_found", "tmdb not found", { userMessage: t("unknownRef") });
    throw kino.error("unavailable", "tmdb " + code, { userMessage: (e && e.userMessage) || t("noTmdb") });
  }
}

const TTL_GENRES = 24 * 60 * 60 * 1000;

/** TMDB's genre names by id, for movies and for series, in the person's language. */
async function genreNames() {
  return stored("g1-" + tmdbLang(), TTL_GENRES, async () => {
    const [movie, tv] = await Promise.all([tmdb("/genre/movie/list"), tmdb("/genre/tv/list")]);
    const map = (d) => Object.fromEntries(((d && d.genres) || []).map((g) => [g.id, String(g.name)]));
    return { movie: map(movie), tv: map(tv) };
  });
}

// ---- 5. titles ---------------------------------------------------------------------------------------------------

function hash(s) {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = (Math.imul(b, 33) + c) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function safeId(raw) {
  return String(raw).replace(/[^A-Za-z0-9._~-]/g, "-").slice(0, 120) || "x";
}

function httpUrl(v) {
  return typeof v === "string" && /^https?:\/\//.test(v) && v.length <= 2048 ? v : undefined;
}

function num(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

const VISUAL = /[\u{1F000}-\u{1FFFF}☀-➿️‍]/gu;
const BLANK = /^[\s⠀​-‍﻿]*$/;

/**
 * A ref is JSON. A title: { k: "movie" | "series", t: TMDB id, m: IMDb id when known }; an episode adds { s, e }; a live
 * channel: { k: "tv", id: the server's id }; a "Ver más" page: { k, e: TMDB endpoint, q: its fixed filters }.
 */
function makeRef(o) {
  return JSON.stringify(o);
}

function parseRef(ref) {
  try {
    const r = JSON.parse(String(ref));
    if (r && typeof r.k === "string") return r;
  } catch { /* falls through */ }
  throw kino.error("not_found", "bad ref", { userMessage: t("unknownRef") });
}

function image(path, size) {
  return typeof path === "string" && path.startsWith("/") ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

/** One TMDB result as a Kino item; `kind` is "movie" or "series". */
function titleItem(r, kind, names) {
  const title = String(kind === "movie" ? r.title || r.original_title : r.name || r.original_name || "").trim();
  if (!r || !r.id || !title) return null;
  const item = { id: (kind === "movie" ? "m" : "s") + r.id, ref: makeRef({ k: kind, t: r.id }), title: title.slice(0, 200), kind, ids: { tmdb: r.id } };
  const date = String((kind === "movie" ? r.release_date : r.first_air_date) || "");
  const y = num(date.slice(0, 4));
  if (y >= 1870 && y <= 2100) item.year = y;
  const poster = image(r.poster_path, "w342");
  if (poster) item.poster = poster;
  const backdrop = image(r.backdrop_path, "w780");
  if (backdrop) item.backdrop = backdrop;
  if (r.overview) item.overview = String(r.overview);
  const original = String(kind === "movie" ? r.original_title || "" : r.original_name || "").trim();
  if (original && original !== title) item.originalTitle = original.slice(0, 200);
  if (r.vote_average > 0) item.rating = Math.round(r.vote_average * 10) / 10;
  const table = (names && names[kind === "movie" ? "movie" : "tv"]) || {};
  const genres = (Array.isArray(r.genre_ids) ? r.genre_ids : []).map((id) => table[id]).filter(Boolean).map((g) => String(g).slice(0, 30)).slice(0, 5);
  if (genres.length) item.genres = genres;
  return item;
}

function itemsOf(results, kind, names) {
  const seen = new Set();
  const items = [];
  for (const r of Array.isArray(results) ? results : []) {
    const item = titleItem(r, kind, names);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

/** What `kino.meta` knows about a title by its TMDB id: the whole of its page, episodes and every id Kino has. */
async function metaOf(kind, tmdbId) {
  if (typeof kino.meta !== "function") throw kino.error("unavailable", "no kino.meta", { userMessage: t("noTmdb") });
  try {
    const answer = await kino.meta({ type: kind, ids: { tmdb: tmdbId } });
    if (!answer) throw kino.error("not_found", "no meta", { userMessage: t("unknownRef") });
    return answer;
  } catch (e) {
    if (e && e.code === "not_found") throw e;
    kino.log("kino.meta failed: " + (e && e.code));
    throw kino.error("unavailable", "meta " + (e && e.code), { userMessage: (e && e.userMessage) || t("noTmdb") });
  }
}

function infoOf(meta) {
  return {
    title: meta.title ? String(meta.title).slice(0, 200) : undefined,
    poster: httpUrl(meta.poster),
    backdrop: httpUrl(meta.backdrop),
    overview: meta.overview ? String(meta.overview) : undefined,
    genres: meta.genres && meta.genres.length ? meta.genres.slice(0, 5) : undefined,
    year: num(meta.year) || undefined,
    ids: meta.ids,
    runtimeMinutes: meta.runtimeMinutes,
  };
}

export async function details(ref) {
  const r = parseRef(ref);
  if (r.k !== "movie" || !r.t) throw kino.error("not_found", "not a movie", { userMessage: t("unknownRef") });
  return infoOf(await metaOf("movie", r.t));
}

export async function episodes(ref) {
  const r = parseRef(ref);
  if (r.k !== "series" || !r.t) throw kino.error("not_found", "not a series", { userMessage: t("unknownRef") });
  const meta = await metaOf("series", r.t);
  const imdb = meta.ids && meta.ids.imdb;
  const list = [];
  for (const ep of Array.isArray(meta.episodes) ? meta.episodes : []) {
    const season = num(ep.season);
    const number = num(ep.number);
    if (season < 1 || season > 999 || number < 1 || number > 99999) continue; // specials (season 0) have no place in Kino's numbering
    const entry = { season, number, ref: makeRef({ k: "series", t: r.t, m: imdb || undefined, s: season, e: number }) };
    if (ep.title) entry.title = String(ep.title).slice(0, 200);
    const still = httpUrl(ep.still);
    if (still) entry.still = still;
    if (ep.overview) entry.overview = String(ep.overview);
    const aired = /^\d{4}-\d{2}-\d{2}/.exec(String(ep.airDate || ""));
    if (aired) entry.airDate = aired[0];
    list.push(entry);
  }
  if (!list.length) throw kino.error("not_found", "no episodes", { userMessage: t("noEpisodes") });
  list.sort((a, b) => (a.season - b.season) || (a.number - b.number));
  return { series: infoOf(meta), episodes: list };
}

// ---- 6. rows -----------------------------------------------------------------------------------------------------

const ROW_ITEMS = 15;
const DEADLINE_MS = 9000;

/** The TMDB list a row shows: an endpoint of one kind plus fixed filters. `kind` is "movie" or "series". */
function listSpec(kind, title, endpoint, q) {
  return { kind, title, endpoint, q: q || {} };
}

async function fetchList(spec, page) {
  return tmdb(spec.endpoint, Object.assign({ page: page || 1, include_adult: false }, spec.q));
}

function rowRef(spec) {
  return makeRef({ k: spec.kind, e: spec.endpoint, q: spec.q });
}

async function listRows(specs) {
  const names = await genreNames();
  const pages = await pool(specs, 5, async (spec) => (await fetchList(spec, 1)).results);
  const rows = [];
  specs.forEach((spec, i) => {
    const items = itemsOf(pages[i], spec.kind, names).slice(0, ROW_ITEMS);
    if (items.length) rows.push({ id: "r" + hash(spec.endpoint + JSON.stringify(spec.q) + spec.kind), title: spec.title.slice(0, 100), items, ref: rowRef(spec) });
  });
  return rows;
}

/** The lists every kind has: what is trending, popular and best rated, and what is on now. */
function mainSpecs(kind) {
  const movie = kind === "movie";
  const word = movie ? "cinema" : "series";
  return [
    listSpec(kind, `${t(word)} · ${t("trending")}`, movie ? "/trending/movie/week" : "/trending/tv/week"),
    listSpec(kind, `${t(word)} · ${t("popular")}`, movie ? "/movie/popular" : "/tv/popular"),
    listSpec(kind, `${t(word)} · ${t("topRated")}`, movie ? "/movie/top_rated" : "/tv/top_rated"),
    listSpec(kind, `${t(word)} · ${t(movie ? "nowPlaying" : "onAir")}`, movie ? "/movie/now_playing" : "/tv/on_the_air"),
  ];
}

/** TMDB's own genre ids people look for most, per kind; the names come from TMDB in the person's language. */
const MOVIE_GENRES = [28, 35, 18, 27, 878, 16, 10749, 53, 12, 80, 14, 99];
const SERIES_GENRES = [10759, 35, 18, 80, 10765, 16, 9648, 10751, 99, 10762, 10764, 10766];

function genreSpecs(kind, names, limit) {
  const movie = kind === "movie";
  const table = movie ? names.movie : names.tv;
  const word = movie ? "cinema" : "series";
  return (movie ? MOVIE_GENRES : SERIES_GENRES)
    .filter((id) => table[id])
    .slice(0, limit)
    .map((id) => listSpec(kind, `${t(word)} · ${table[id]}`, movie ? "/discover/movie" : "/discover/tv", { with_genres: id, sort_by: "popularity.desc" }));
}

function rowsSetting() {
  const n = num(kino.config.get("homeRows"));
  return n > 0 && n <= 12 ? n : 4;
}

export async function home() {
  const manifest = await loadManifest(false);
  const specs = mainSpecs("movie").concat(mainSpecs("series"));
  // Movies and series alternate, so a short Home shows both.
  const ordered = [];
  for (let i = 0; i < 4; i++) ordered.push(specs[i], specs[4 + i]);
  const [rows, live] = await Promise.all([listRows(ordered.slice(0, rowsSetting())), liveHomeRows(manifest).catch(() => [])]);
  return live.concat(rows);
}

// ---- the section: three tabs (movies, series, live), each with the lists above and its genres

export async function section(arg) {
  const tabs = [
    { id: "cinema", label: t("cinema") },
    { id: "series", label: t("series") },
    { id: "live", label: t("live") },
  ];
  const tab = tabs.find((x) => x.id === (arg && arg.tab)) || tabs[0];
  if (tab.id === "live") return { tabs, tab: tab.id, rows: await liveRows(await loadManifest(false)) };
  const kind = tab.id === "cinema" ? "movie" : "series";
  const names = await genreNames();
  return { tabs, tab: tab.id, rows: await listRows(mainSpecs(kind).concat(genreSpecs(kind, names, 6))) };
}

// ---- Categorías: a tile per genre, with a poster of its most popular title

const TTL_ART = 24 * 60 * 60 * 1000;
const ART_PER_CALL = 6; // posters asked per call: the rest fill in on later visits, so the TMDB budget is never spent here

async function genreArt(specs) {
  const key = "a1-" + tmdbLang();
  let cached = { at: Date.now(), v: {} };
  try {
    const e = JSON.parse(kino.storage.get(key) || "null");
    if (e && e.v && Date.now() - e.at < TTL_ART) cached = e;
  } catch { /* unreadable: start again */ }
  const missing = specs.filter((spec) => !cached.v[rowRef(spec)]).slice(0, ART_PER_CALL);
  if (missing.length) {
    const found = await pool(missing, 3, async (spec) => {
      const first = ((await fetchList(spec, 1)).results || []).find((r) => r.poster_path);
      return first ? image(first.poster_path, "w342") : undefined;
    });
    missing.forEach((spec, i) => { if (found[i]) cached.v[rowRef(spec)] = found[i]; });
    try { kino.storage.set(key, JSON.stringify(cached)); } catch { /* storage full: not cached */ }
  }
  return cached.v;
}

export async function categories() {
  const names = await genreNames();
  const specs = genreSpecs("movie", names, 8).concat(genreSpecs("series", names, 8));
  const art = await genreArt(specs);
  return specs.map((spec) => {
    const ref = rowRef(spec);
    const tile = { id: "g" + hash(ref), title: spec.title.slice(0, 40), ref };
    if (art[ref]) tile.art = art[ref];
    return tile;
  });
}

/** "Ver más": a page of the same TMDB list; the cursor is its page number. */
export async function browse(ref, cursor) {
  const r = parseRef(ref);
  if (!r.e || typeof r.e !== "string") throw kino.error("not_found", "bad ref", { userMessage: t("unknownRef") });
  const kind = r.k === "movie" ? "movie" : "series";
  const page = Math.max(1, num(cursor) || 1);
  const [names, data] = await Promise.all([genreNames(), fetchList({ endpoint: r.e, q: r.q || {} }, page)]);
  const items = itemsOf(data.results, kind, names);
  return page < Math.min(num(data.total_pages), 20) ? { items, next: String(page + 1) } : { items };
}

export async function search(query) {
  const q = String(query.q || "").trim();
  const wanted = query.type === "movie" ? "movie" : query.type === "series" ? "tv" : null;
  const names = await genreNames();
  // Kino looking for one title it already knows (by TMDB id): answer that title, whichever kind it is.
  if (query.tmdbId > 0) {
    const kinds = wanted === "tv" ? ["series"] : wanted === "movie" ? ["movie"] : ["movie", "series"];
    const found = await pool(kinds, 2, async (kind) => titleItem(await tmdb(kind === "movie" ? `/movie/${query.tmdbId}` : `/tv/${query.tmdbId}`), kind, names));
    const items = found.filter(Boolean);
    if (items.length) return items;
  }
  if (q.length < 2) return [];
  const data = await tmdb("/search/multi", { query: q, include_adult: false, page: 1 });
  const items = [];
  for (const r of data.results || []) {
    if (r.media_type !== "movie" && r.media_type !== "tv") continue;
    const item = titleItem(r, r.media_type === "movie" ? "movie" : "series", names);
    if (item) items.push(item);
  }
  // The type Kino leans towards goes first; the order inside each group is TMDB's.
  if (wanted) items.sort((a, b) => (a.kind === (wanted === "tv" ? "series" : "movie") ? 0 : 1) - (b.kind === (wanted === "tv" ? "series" : "movie") ? 0 : 1));
  return items.slice(0, 40);
}

// ---- 7. streams --------------------------------------------------------------------------------------------------

const LANGS = {
  eng: "en", spa: "es", por: "pt", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", hin: "hi", jpn: "ja", kor: "ko",
  chi: "zh", zho: "zh", ara: "ar", rus: "ru", tur: "tr", ind: "id", tam: "ta", tel: "te", ben: "bn", mal: "ml", kan: "kn",
};

function langOf(code) {
  const c = String(code || "").toLowerCase().trim();
  return (LANGS[c] || c || "und").slice(0, 16);
}

function trackFormat(url) {
  const decoded = decodeURIComponent(url.split("?")[0] + " " + (/[?&]url=([^&]+)/.exec(url) || [, ""])[1]);
  return /\.vtt\b/i.test(decoded) ? "vtt" : /\.srt\b/i.test(decoded) ? "srt" : undefined;
}

function tracksOf(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const url = s && httpUrl(s.url);
    if (!url) continue;
    const track = { lang: langOf(s.lang), url };
    const format = trackFormat(url);
    if (format) track.format = format;
    out.push(track);
  }
  return out;
}

function headersOf(s) {
  const h = s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request;
  if (!h || typeof h !== "object") return undefined;
  const out = {};
  for (const k of Object.keys(h).slice(0, 20)) if (typeof h[k] === "string") out[k] = h[k];
  return Object.keys(out).length ? out : undefined;
}

function mimeOf(url) {
  const path = url.split("?")[0];
  if (/\.m3u8$/i.test(path) || /\.m3u8/i.test(url)) return "application/x-mpegURL";
  if (/\.mpd$/i.test(path)) return "application/dash+xml";
  return undefined;
}

/** A stream with ClearKey keys cannot be decrypted by the player. */
function drmBlocked(s) {
  return !!(s.clearkey || s.drm || /[?&]clearkey=/i.test(String(s.url || "")));
}

/** A stream Kino can play: a URL, and not a torrent, a YouTube id, a link out to a web page or one that needs a key. */
function playable(s) {
  return !!s && typeof s.url === "string" && /^https?:\/\//.test(s.url) && !s.infoHash && !s.ytId && !drmBlocked(s);
}

// The server describes each stream in its title ("2160p · Hindi, English · 65.95 GB"): the quality and size only order
// and filter the copies. A title that says neither keeps the server's own order.
const QUALITY_RANK = { "2160p": 4, "1080p": 3, "720p": 2, "480p": 1 };

function qualityOf(s) {
  const text = `${s.name || ""} ${s.title || ""}`.toLowerCase();
  if (/\b(2160p|4k)\b/.test(text)) return "2160p";
  for (const q of ["1080p", "720p", "480p"]) if (text.includes(q)) return q;
  return undefined;
}

function sizeGbOf(s) {
  const m = /([\d.]+)\s*(gb|mb)\b/i.exec(`${s.title || ""} ${s.name || ""}`);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? (m[2].toLowerCase() === "mb" ? n / 1024 : n) : undefined;
}

function preferredRank() {
  const q = String(kino.config.get("quality") || "auto");
  return QUALITY_RANK[q] || QUALITY_RANK["1080p"];
}

// A person who uses Kino in Spanish wants the copies that say so first; the server writes the language in the title.
const SPANISH = /\b(spanish|español|espanol|latino|castellano|spa|esp)\b|\b(es|lat)\s*(dub|audio)\b/i;

function inMyLanguage(s) {
  return String(kino.lang || "").toLowerCase().startsWith("es") && SPANISH.test(`${s.name || ""} ${s.title || ""}`);
}

/** The copies the person's settings allow: their language first, then the closest to the preferred quality, the lighter file among equals, then the server's order. */
function ordered(list) {
  const maxGb = parseFloat(String(kino.config.get("maxSize") || "0")) || 0;
  let usable = list;
  if (maxGb > 0) {
    const small = list.filter((s) => { const gb = sizeGbOf(s); return gb === undefined || gb <= maxGb; });
    if (small.length) usable = small; // never leave the person with nothing because of a size limit
  }
  const want = preferredRank();
  const score = (s) => { const r = QUALITY_RANK[qualityOf(s)]; return r ? Math.abs(r - want) : 99; };
  return usable
    .map((s, i) => ({ s, i, l: inMyLanguage(s) ? 0 : 1, k: score(s), gb: sizeGbOf(s) ?? 50 }))
    .sort((a, b) => (a.l - b.l) || (a.k - b.k) || (a.gb - b.gb) || (a.i - b.i))
    .map((x) => x.s);
}

function labelOf(s) {
  const first = String(s.title || "").split("\n")[0];
  const text = (first || String(s.name || "")).replace(VISUAL, "").replace(/\s+/g, " ").trim().slice(0, 48);
  return text || undefined;
}

function streamFor(list, live) {
  const seen = new Set();
  const usable = ordered(list.filter(playable).filter((s) => !seen.has(s.url) && seen.add(s.url)));
  if (!usable.length) return null;
  const taken = new Map();
  const unique = (text) => {
    if (!text) return text;
    const n = (taken.get(text) || 0) + 1;
    taken.set(text, n);
    return n === 1 ? text : `${text} · ${n}`.slice(0, 48);
  };
  const main = usable[0];
  const stream = { url: main.url };
  const mime = mimeOf(main.url);
  if (mime) stream.mime = mime;
  const headers = headersOf(main);
  if (headers) stream.headers = headers;
  const label = unique(labelOf(main));
  if (label) stream.label = label;
  if (live) {
    stream.expiresInSeconds = 1800; // live URLs may carry short-lived tokens: ask again when one stops working
  } else {
    const subs = [];
    const urls = new Set();
    for (const s of usable) for (const track of tracksOf(s.subtitles)) if (!urls.has(track.url) && urls.add(track.url)) subs.push(track);
    if (subs.length) stream.subtitles = subs.slice(0, 30);
  }
  const alternatives = [];
  for (const s of usable.slice(1, 9)) {
    const alt = { url: s.url };
    const m = mimeOf(s.url);
    if (m) alt.mime = m;
    const h = headersOf(s);
    if (h) alt.headers = h;
    const l = unique(labelOf(s));
    if (l) alt.label = l;
    alternatives.push(alt);
  }
  if (alternatives.length) stream.alternatives = alternatives;
  return stream;
}

/** The server asks its sources when a title is requested, so this one is slow (about ten seconds). */
async function streamsOf(path) {
  const data = await getJson(path, 18000, "warming");
  return Array.isArray(data && data.streams) ? data.streams : [];
}

/** The IMDb id the server asks for: the one in the ref, else what Kino knows, else what TMDB says. */
async function imdbOf(r) {
  if (r.m) return r.m;
  try {
    const answer = await metaOf(r.k, r.t);
    if (answer.ids && answer.ids.imdb) return answer.ids.imdb;
  } catch { /* try TMDB itself */ }
  const ext = await tmdb(r.k === "movie" ? `/movie/${r.t}/external_ids` : `/tv/${r.t}/external_ids`);
  return ext && ext.imdb_id ? String(ext.imdb_id) : "";
}

export async function resolve(ref) {
  const r = parseRef(ref);
  let list;
  if (r.k === "tv") {
    list = await streamsOf(`/stream/tv/${enc(r.id)}.json`);
  } else {
    if (!r.t) throw kino.error("not_found", "bad ref", { userMessage: t("unknownRef") });
    const imdb = await imdbOf(r);
    if (!/^tt\d+$/.test(imdb)) throw kino.error("not_found", "no imdb", { userMessage: t("noImdb") });
    list = await streamsOf(r.k === "movie" ? `/stream/movie/${imdb}.json` : `/stream/series/${imdb}:${num(r.s) || 1}:${num(r.e) || 1}.json`);
  }
  const stream = streamFor(list, r.k === "tv");
  if (!stream) {
    const blocked = list.some((s) => s && typeof s.url === "string" && drmBlocked(s));
    throw kino.error("unavailable", "no streams", { userMessage: t(blocked ? "drmOnly" : r.k === "tv" ? "noChannel" : "noStreams") });
  }
  return stream;
}

export async function subtitles(arg) {
  if (!arg.imdbId) return [];
  const series = arg.kind === "series";
  const id = series && arg.season && arg.episode ? `${arg.imdbId}:${arg.season}:${arg.episode}` : arg.imdbId;
  const data = await getJson(`/subtitles/${series ? "series" : "movie"}/${enc(id)}.json`, 9000);
  return tracksOf(data && data.subtitles);
}

// ---- 8. live -----------------------------------------------------------------------------------------------------

/** The server's genre words mapped to Kino's closed vocabulary, so En vivo can filter across plugins; others stay unmapped. */
const LIVE_GENRES = {
  sports: "deportes", cricket: "deportes", football: "deportes", soccer: "deportes", news: "noticias", kids: "infantil",
  music: "musica", documentary: "documentales", movies: "peliculas", entertainment: "entretenimiento",
};

function catalogPath(cat, genre, search) {
  const extras = [];
  if (genre) extras.push("genre=" + enc(genre));
  if (search) extras.push("search=" + enc(search));
  return `/catalog/${enc(cat.type)}/${enc(cat.id)}${extras.length ? "/" + extras.join("&") : ""}.json`;
}

async function liveMetas(cat, genre, search, timeoutMs) {
  const path = catalogPath(cat, genre, search);
  const data = await cachedMem(path, TTL_PAGE, () => getJson(path, timeoutMs || 15000));
  return Array.isArray(data && data.metas) ? data.metas.filter((m) => m && typeof m.id === "string") : [];
}

/** The live categories: every genre the server lists for each live catalog, plus the catalog's whole list. */
function liveCategoryList(manifest) {
  const out = [];
  for (const cat of manifest.catalogs) {
    out.push({ id: "a" + hash(cat.id), title: cat.name.replace(VISUAL, "").trim().slice(0, 40) || cat.id, cat, genre: null });
    for (const genre of cat.genres) out.push({ id: "g" + hash(cat.id + "|" + genre), title: genre.slice(0, 40), cat, genre });
  }
  return out;
}

function channelOf(m, categoryId) {
  const title = BLANK.test(String(m.name || "")) ? "" : String(m.name).replace(/\s+/g, " ").trim();
  if (!title) return null;
  const channel = { id: safeId(m.id), title: title.slice(0, 200), ref: makeRef({ k: "tv", id: m.id }), categoryId };
  const logo = httpUrl(m.logo) || httpUrl(m.poster);
  if (logo) channel.logo = logo;
  return channel;
}

export async function liveCategories() {
  const manifest = await loadManifest(false);
  return liveCategoryList(manifest).map((c) => {
    const out = { id: c.id, title: c.title };
    const genre = c.genre ? LIVE_GENRES[c.genre.toLowerCase()] : undefined;
    if (genre) out.genre = genre;
    return out;
  });
}

export async function liveChannels(arg) {
  const manifest = await loadManifest(false);
  const entry = liveCategoryList(manifest).find((c) => c.id === arg.categoryId);
  if (!entry) return { items: [] };
  const taken = new Set();
  const items = [];
  for (const m of (await liveMetas(entry.cat, entry.genre, null)).slice(0, 500)) {
    const channel = channelOf(m, arg.categoryId);
    if (!channel || taken.has(channel.id)) continue;
    taken.add(channel.id);
    items.push(channel);
  }
  return { items };
}

export async function liveSearch(arg) {
  const q = String(arg.query || "").trim();
  if (q.length < 2) return { items: [] };
  const manifest = await loadManifest(false);
  const cats = manifest.catalogs.filter((c) => c.search).slice(0, 6);
  const found = await pool(cats, 3, async (cat) => (await liveMetas(cat, null, q, 10000)).slice(0, 50).map((m) => channelOf(m, "a" + hash(cat.id))).filter(Boolean));
  const seen = new Set();
  const items = [];
  for (const list of found) for (const c of list || []) if (!seen.has(c.id) && seen.add(c.id)) items.push(c);
  return { items: items.slice(0, 100) };
}

/** A section row per live category that has channels: the genres first, the whole list last. */
async function liveRows(manifest) {
  const cats = liveCategoryList(manifest);
  const specific = cats.filter((c) => c.genre).concat(cats.filter((c) => !c.genre));
  const pages = await pool(specific, 5, async (c) => (await liveMetas(c.cat, c.genre, null, 10000)).slice(0, ROW_ITEMS));
  const rows = [];
  specific.forEach((c, i) => {
    const items = (pages[i] || []).map((m) => channelOf(m, c.id)).filter(Boolean).map((ch) => {
      const item = { id: ch.id, ref: ch.ref, title: ch.title, kind: "live" };
      if (ch.logo) item.poster = ch.logo;
      return item;
    });
    if (items.length) rows.push({ id: "v" + c.id, title: c.title, items });
  });
  return rows;
}

/** Home: a row of live channels from the first live catalog. */
async function liveHomeRows(manifest) {
  const cat = manifest.catalogs[0];
  if (!cat) return [];
  const items = (await liveMetas(cat, null, null, 10000))
    .slice(0, ROW_ITEMS)
    .map((m) => channelOf(m, "a" + hash(cat.id)))
    .filter(Boolean)
    .map((ch) => {
      const item = { id: ch.id, ref: ch.ref, title: ch.title, kind: "live" };
      if (ch.logo) item.poster = ch.logo;
      return item;
    });
  return items.length ? [{ id: "v" + hash(cat.id), title: t("live"), items }] : [];
}

// ---- 9. settings -------------------------------------------------------------------------------------------------

function detailOf(e) {
  return (e && (e.userMessage || e.code)) || "error";
}

export async function settingsStatus() {
  try {
    const manifest = await loadManifest(false);
    const cat = manifest.catalogs[0];
    const count = cat ? (await liveMetas(cat, null, null, 10000)).length : 0;
    return { serverStatus: t("online", { channels: count }) };
  } catch (e) {
    return { serverStatus: t("offline", { detail: detailOf(e) }) };
  }
}

/** Walks the same road a person does (manifest, a title from the catalog, its sources, a live channel). */
export async function action(key) {
  if (key !== "checkConn") return null;
  let manifest;
  try { manifest = await loadManifest(true); } catch (e) { return { message: t("stepManifest", { detail: detailOf(e) }) }; }
  let imdb;
  try {
    const first = ((await tmdb("/trending/movie/week")).results || [])[0];
    if (!first) throw kino.error("unavailable", "empty");
    imdb = String((await tmdb(`/movie/${first.id}/external_ids`)).imdb_id || "");
  } catch (e) { return { message: t("stepTitles", { detail: detailOf(e) }) }; }
  try {
    if (!/^tt\d+$/.test(imdb) || !streamFor(await streamsOf(`/stream/movie/${imdb}.json`), false)) throw kino.error("unavailable", "no streams");
  } catch (e) { return { message: t("stepStream", { detail: detailOf(e) }) }; }
  try {
    const cat = manifest.catalogs[0];
    const metas = cat ? await liveMetas(cat, null, null, 15000) : [];
    if (!metas.length || !streamFor(await streamsOf(`/stream/tv/${enc(metas[0].id)}.json`), true)) throw kino.error("unavailable", "no live");
  } catch (e) { return { message: t("stepLive", { detail: detailOf(e) }) }; }
  return { message: t("ok") };
}
