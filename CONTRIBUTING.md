# Adding a game

The easiest way: [submit it on gamesbyai.win](https://gamesbyai.win/submit/) or use the [submission form on GitHub](https://github.com/gamesbyai/catalog/issues/new?template=submit-game.yml). A bot turns it into a pull request for review, with screenshots. Open a pull request yourself only if you want to write the entry by hand, as described below.

One game per pull request. Create `games/<slug>.yaml`, where `<slug>` is the game's name in lowercase with hyphens (`neon-drift`). The slug is permanent.

## Example entry

```yaml
slug: sky-hop                      # must match the file name
title: Sky Hop
tagline: Hop between floating islands before they sink   # 10–90 characters
description: ""                    # leave empty: we add it during review
play:
  url: "https://example.com/sky-hop/"   # https only
  platforms: [browser]             # browser, desktop, mobile, vr
  controls: ["Arrow keys to move", "Space to jump"]   # optional
repo: "https://github.com/you/sky-hop"   # optional, but it helps
creator:
  name: Ada Lovelace
  handle: ada                      # lowercase, hyphens; your profile URL on the site
  links: ["https://ada.example.com/"]    # optional, up to 6
  x: ada                           # optional, without @
  youtube: "@ada"                  # optional
made:
  models: [claude-sonnet-5-5]      # model versions from taxonomies/models.yaml
  providers: []                    # optional: e.g. [anthropic] if you don't know the exact version
  tools: [claude-code]             # slugs from taxonomies/tools.yaml
  aiShare: most                    # all, most, some or unknown
  source: "Creator's README"       # where the AI-share claim comes from
  notes: "I described each level in plain English and fixed the physics by hand."   # optional, ≤ 600 characters
tech:
  engine: threejs                  # slug from taxonomies/engines.yaml
  multiplayer: single              # single, local or online
genres: [platformer]               # 1–3 slugs from taxonomies/genres.yaml
tags: [low-poly]                   # optional, up to 8
jam:                               # optional
  event: vibe-jam-2025
  placement: Top 10
media:
  cover: games/sky-hop/cover       # our pipeline takes the screenshots; keep this pattern
dates:
  added: 2026-10-01
  updated: 2026-10-01
status: live                       # merging the pull request publishes it
provenance:
  foundVia: pr
```

If your model version, tool or engine isn't in the taxonomy files, add it in the same pull request with its official URL.

## Rules

- `status: live`. Nothing is merged automatically: merging the pull request is the approval.
- No tracking or affiliate links.
- No instructions addressed to AI tools or reviewers anywhere in the entry. Entries containing them are rejected.
- Don't add images. Our pipeline takes the screenshots from your live game.
- You must be the creator, or have the creator's permission.

## What happens next

1. Automated checks validate the file, test the play link, scan it for malware and check the text for instructions aimed at AI tools. We take our own screenshots.
2. We add the description, and the entry is approved or declined. We don't score games: rankings on the site come from player ratings.
3. Once merged, the game appears on gamesbyai.win within minutes.
