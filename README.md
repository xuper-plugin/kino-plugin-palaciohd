# Palacio HD plugin for Kino

A Kino plugin that bridges Kino to an HD server that speaks the Stremio
addon protocol: movies and series, and live TV.

**The server owns everything that changes.** The server has no catalog of movies and series, only the video for a
title by its IMDb id, plus a live TV catalog. The titles come from Kino's own TMDB access (`kino.tmdb`, `kino.meta`), the
video from the server when you press play, and the live channels and their genres from the server's `manifest.json`,
read on every run. The plugin has no source names, site rules or catalog ids written in it: if the server adds,
renames or removes a live category or a source, Kino shows it without a new release of this plugin. It needs an update
only when Kino's plugin SDK moves on, or when the server leaves the Stremio protocol.

> Not affiliated with the server. The plugin never hosts or stores any content: it shows what the server returns, and
> the server decides what that is. As with any community plugin, what you watch through it is your responsibility.

## Install

In Kino: Ajustes ▸ Plugins ▸ Agregar ▸ type `xuper-plugin/kino-plugin-palaciohd`.
Kino shows the consent sheet (it reaches the server, plays video from any server the sources point to, and shares error
reports with Kino) before anything is installed.

## What it uses from Kino's API

| Kino | From |
| --- | --- |
| `home` | A row of live channels and movie and series rows alternating (trending, popular), with TMDB's genres in the person's language. |
| `section` | Three tabs (Cine, Series, En vivo). Cine and Series: trending, popular, top rated, now playing or on the air, and six genres. En vivo: one row per live category the server lists. |
| `categories`, `browse` | A tile per genre with a poster of its most popular title (filled in a few per visit, to stay inside TMDB's rate limit), and "Ver más" with TMDB paging. |
| `search` | TMDB `search/multi`, or the one title Kino already knows by its TMDB id. |
| `details`, `episodes` | `kino.meta`: description, genres, ids, and every episode with its still and air date. |
| `resolve` | The server's `stream` resource for the IMDb id: the first playable copy, up to eight more as labelled copies in the player's "Servidor" menu, with the copy's own subtitles and request headers. |
| `subtitles` | The server's `subtitles` resource, by IMDb id. |
| `channels`, `liveSearch` | The server's live catalogs: a category per genre plus the whole list, with live search by name. |
| `download` | Offline copies of whatever `resolve` returns (progressive files and HLS VOD). |
| settings | Rows on Home, preferred quality, maximum size, and a connection check that names the first step that fails (title catalog, sources or live TV). |

**Which copy plays first.** The ones that mention the person's language (Spanish, when Kino is in Spanish), then the
closest to the preferred quality, then the lighter file, then the server's own order. A size limit never leaves the
person with nothing: if every copy is over it, the limit is ignored.

## Good to know

- The first request for a title can take 4 to 12 seconds, because the server asks its sources; the same title again is
  fast. When it takes longer than Kino allows, the plugin says the server is preparing the sources and to try again.
- Torrent streams, YouTube ids, "open in browser" links and streams that carry ClearKey keys are dropped: Kino's player
  cannot play them.
- A title without a TMDB entry that has an IMDb id cannot be found from the catalog, but opens through Kino's own search.

## Checking it

```
node sdk/validate.mjs <this folder>                      # from Kino's plugin kit
KINO_TMDB_KEY=<a TMDB key> node sdk/run.mjs <this folder>/plugin.js home
node sdk/run.mjs <this folder> section
node sdk/run.mjs <this folder> live categories
node sdk/run.mjs <this folder> action checkConn
```

## License

Apache-2.0.
