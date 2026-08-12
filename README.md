# Download

Fliks on its own knows what you have and what you want. This plugin is what goes and gets it:
it searches your trackers, decides which release is the right one, hands it to your download
client, and files the finished download into your library.

Install it from the plugin catalogue in **Settings → Advanced → Plugins**. Without it, Fliks has
no downloading of any kind — that is deliberate, and removing the plugin removes the feature
whole.

## What it does for you

- **Finds releases.** It queries every tracker you have configured, in parallel, and scores what
  comes back against the quality profile and the language profile of the title in question.
- **Picks for you, or lets you pick.** Monitored titles are grabbed automatically when an
  acceptable release appears. From a title's own menu you can also search yourself and choose a
  specific release, or ask for the best one right now.
- **Watches the download.** It follows progress in your download client, and when a download
  finishes it moves the file into the library and marks the title as available.
- **Cleans up after itself.** A download that stalls is retried or removed; a torrent that has
  finished seeding to your target ratio is cleared out.
- **Keeps working while you sleep.** Missing episodes and films are searched on a schedule, and
  new releases arrive through your trackers' feeds.

## What you need first

**A tracker aggregator that speaks Torznab.** You give the plugin a base URL and an API key per
tracker; anything Torznab-compatible works, and one aggregator can expose many trackers.

**qBittorrent.** It is the only download client this version supports. The plugin needs its
address and, if you have set them, its username and password.

## Setting it up

1. **Settings → Download → Indexers**, *New indexer*. Paste the tracker's Torznab URL and its
   API key, then use *Test connection* before saving — it tells you straight away whether the
   URL and the key are right.
2. **Settings → Download → Download clients**, *New download client*. Fill in your qBittorrent
   address and credentials, and test the connection the same way.
3. Give a film or a series a **quality profile** and a **language profile**, and mark it
   monitored. That is what tells the plugin what "the right release" means for that title.

That is all. The first search runs on the next scheduled pass, or immediately if you use *Search
releases* from the title's own menu.

## Living with it

**Two ways to stop seeding.** Per tracker you set a share-ratio target and, if you want, a maximum
number of days: a finished torrent leaves when either is reached, so one that will never hit the
ratio still goes on time.

**Priorities matter.** Each tracker has a priority; when two releases score the same, the
higher-priority tracker wins. Each also has a minimum seeder count and a request delay, so a
tracker that rate-limits you is not hammered.

**A failing tracker steps aside.** Repeated failures put a tracker in a cooldown instead of
blocking every search behind it. You can see and clear cooldowns from the indexers page.

**Some trackers advertise more than they support.** The plugin asks each tracker what searches it
handles, and if a typed search is refused it falls back to a plain text search and remembers that
for next time.

**Where its data lives.** Trackers, download clients, history and the block list are the
plugin's own — they live in its own database schema. Uninstalling deletes them; switching the
plugin off from the plugins page does not.

## What this version does not do

- **Only qBittorrent.** No other download client is supported yet.
- **The unknown-language field is free text.** A typo in an ISO code is stored as typed, with
  nothing to catch it.

## Contributing

How the plugin is built, its wire protocol, its database and its test suite are in
[docs/development.md](docs/development.md).

## License

[AGPL-3.0-or-later](LICENSE) — the same licence as Fliks itself, which this plugin's code was
extracted from.
