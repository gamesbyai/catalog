# GamesByAI catalog

The open catalog behind [gamesbyai.win](https://gamesbyai.win): games made with AI, one YAML file per game.

Every game here passed automated checks (the play link loads, a Cloudflare URL Scanner malware check, injection checks on the text, our own screenshots) and was approved before it went live on the site. Rankings on the site come from player ratings. Each entry records how the game was made (the AI models and tools, and how much of the code AI wrote, according to the creator), where to play it and who made it.

## Add your game

1. Use the form at [gamesbyai.win/submit](https://gamesbyai.win/submit/) (opening soon), or
2. Fork this repo, add `games/<your-game>.yaml` as described in [CONTRIBUTING.md](CONTRIBUTING.md), and open a pull request.

Nothing is merged automatically: every entry is approved before it goes live.

## What gets listed

- **Playable:** a browser build that loads, or a downloadable build with a repo.
- **Substantially AI-made:** stated by the creator, or implied by jam rules (for example, Vibe Jam requires most of the code to be AI-written).
- **A real game:** a goal, feedback and a way to win or lose. A tech demo alone doesn't qualify.
- **Safe:** passes a malware and phishing scan, with no crypto miners, no adult or hateful content, and no collection of personal data without a reason.
- **Not a duplicate:** a fork needs meaningful changes to be listed on its own.

## Taxonomies

| File | Holds |
| --- | --- |
| `taxonomies/providers.yaml` | AI providers and their model family (Anthropic → Claude) |
| `taxonomies/models.yaml` | Model versions, each with its provider (Claude Opus 5.5, GPT-6 Sol…) |
| `taxonomies/tools.yaml` | AI coding agents, editors, extensions, chat apps and app builders |
| `taxonomies/engines.yaml` | Game engines and frameworks |
| `taxonomies/genres.yaml` | Genres |
| `taxonomies/jams.yaml` | Game jams |

## Screenshots

We take every screenshot from the live game, so don't add images to your pull request.

- **Capture:** on `seed/*` and `submission/*` pull requests, `.github/workflows/capture.yml` opens each added or changed game in headless Chromium. Each game gets a fresh browser context with no downloads, no permissions and dialogs dismissed. It saves a cover and two screenshots at 3, 8 and 14 seconds after load.
- **Failures:** a game that hangs, starts a download or crashes stops after 40 seconds, is listed in `out/failed.json`, and the run moves on.
- **No secrets during capture:** game pages are untrusted code, so the capture job gets a read-only token and no secrets.
- **Upload:** a second job, for branches in this repo only, runs the scripts from `main`. It re-encodes each PNG with sharp into AVIF and WebP at 320, 640 and 1280 px, plus a 1200×630 social image for the cover. It uploads them to R2 (`media.gamesbyai.win/games/<slug>/…`) and posts a contact sheet on the pull request.

To try it locally: `node scripts/capture.mjs <slug…>`, then `node scripts/upload.mjs out/ --dry-run`.

### Maintainer setup (once)

1. Cloudflare → R2 → Manage API tokens: create a token with **Object Read & Write**, limited to the bucket `gamesbyai-media`.
2. `gh secret set R2_UPLOAD_TOKEN --repo gamesbyai/catalog` and paste the token when asked.
3. `gh secret set CLOUDFLARE_ACCOUNT_ID --repo gamesbyai/catalog` with the Cloudflare account ID.

## License

The data is licensed under [CC BY 4.0](LICENSE). If you reuse it, credit "GamesByAI (gamesbyai.win)" with a link.
