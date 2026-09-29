# GamesByAI catalog

The open catalog behind [gamesbyai.win](https://gamesbyai.win): games made with AI, one YAML file per game.

Every game here was tested by an editor before it went live on the site. Each entry records how the game was made (the AI models and tools, and how much of the code AI wrote, according to the creator), where to play it and who made it.

## Add your game

1. Use the form at [gamesbyai.win/submit](https://gamesbyai.win/submit/) (opening soon), or
2. Fork this repo, add `games/<your-game>.yaml` as described in [CONTRIBUTING.md](CONTRIBUTING.md), and open a pull request.

Every entry is reviewed by a human before it goes live.

## What gets listed

- **Playable:** a browser build that loads, or a downloadable build with a repo.
- **Substantially AI-made:** stated by the creator, or implied by jam rules (for example, Vibe Jam requires most of the code to be AI-written).
- **A real game:** a goal, feedback and a way to win or lose. A tech demo alone doesn't qualify.
- **Safe:** passes a malware and phishing scan, with no crypto miners, no adult or hateful content, and no collection of personal data without a reason.
- **Not a duplicate:** a fork needs meaningful changes to be listed on its own.

## Taxonomies

| File | Holds |
| --- | --- |
| `taxonomies/models.yaml` | AI model families (and later their versions) |
| `taxonomies/tools.yaml` | AI coding tools and apps |
| `taxonomies/engines.yaml` | Game engines and frameworks |
| `taxonomies/genres.yaml` | Genres |
| `taxonomies/jams.yaml` | Game jams |

## License

The data is licensed under [CC BY 4.0](LICENSE). If you reuse it, credit "GamesByAI (gamesbyai.win)" with a link.
