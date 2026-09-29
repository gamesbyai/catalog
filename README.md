# GamesByAI catalog

The open catalog behind [gamesbyai.win](https://gamesbyai.win): games made with AI, one YAML file per game.

Every game here was reviewed and approved before it went live on the site. Rankings on the site come from player ratings. Each entry records how the game was made (the AI models and tools, and how much of the code AI wrote, according to the creator), where to play it and who made it.

## Add your game

1. Use the form at [gamesbyai.win/submit](https://gamesbyai.win/submit/) (opening soon), or
2. Fork this repo, add `games/<your-game>.yaml` as described in [CONTRIBUTING.md](CONTRIBUTING.md), and open a pull request.

Nothing is merged automatically: every entry is approved before it goes live.

## What gets listed

- **Playable:** a browser build that loads, or a downloadable build with a repo.
- **Substantially AI-made:** stated by the creator, or implied by jam rules (for example, Vibe Jam requires most of the code to be AI-written).
- **A real game:** a goal, feedback and a way to win or lose. A tech demo alone doesn't qualify.
- **Safe:** no malware or phishing, no crypto miners, no adult or hateful content, and no collection of personal data without a reason.
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

## License

The data is licensed under [CC BY 4.0](LICENSE). If you reuse it, credit "GamesByAI (gamesbyai.win)" with a link.
