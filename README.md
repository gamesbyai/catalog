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

The capture job takes screenshots from the live game. Screenshots supplied through the submission form skip the browser; don't add image files to your pull request.

For each game it opens, `scripts/capture.mjs` also writes `out/<slug>/engine.json` beside `cover.png`, `shot-1.png` and `shot-2.png` in the `shots` artifact:

```json
{"engine":"phaser","renderer":"webgl","evidence":["window.Phaser.VERSION 3.80.1"]}
```

An inconclusive detection is `{"engine":null,"renderer":null,"evidence":[]}`. Detection checks every frame after loading and locating the game (including itch.io's game iframe, but not itch.io's own page around it, which loads React for its site), and again after the capture inputs to catch late loading. It reads globals as data descriptors, script and loaded asset URLs, and known DOM markers. It never calls engine functions or evaluates page script text. The renderer comes from contexts the game creates; detection does not call `getContext()` on game canvases. The probe keeps its own copies of the browser methods it uses from before any page script runs, and each frame answers with one JSON string of at most 64 KiB. Capture then reads at most 64 frames and keeps only known global names (with values of up to 200 characters), known DOM and context tokens, and up to 512 script or asset URLs of at most 2,048 characters per frame (64 KiB of URLs per frame, 256 KiB across frames). The first scan waits at most 400 ms alongside the screenshots and the final one at most 750 ms. Failures do not fail screenshot capture.

The first matching slug in this order wins across all frames:

1. `godot`, `unity`, `unreal`, `gamemaker`, `defold`, `construct`, `gdevelop`, `cocos`, `rpg-maker`, `renpy`, `twine`, `bitsy`, `puzzlescript`, `gb-studio`, `pico-8`, `tic-80`, `love2d`, `pygame`, `bevy`, `raylib`, `monogame`, `libgdx`, `flutter`.
2. `phaser`, `kaplay` (also Kaboom), `excalibur`, `littlejs`, `p5js`, `react-three-fiber`, `aframe`, `playcanvas`, `babylonjs`, `threejs`, `pixijs`, `react`, then `null`.

`renderer` is reported on its own, best first: `webgpu` (a GPU canvas context and navigator.gpu), `webgl` (a live WebGL/WebGL2 context), `canvas` (a 2D canvas with drawn pixels), then `null`. It says how the page draws, not what the game was made with, so it is never reported as the engine: bundled builds of many engines hide every name and would otherwise pass for plain WebGL or canvas.

React plus Three.js alone does not establish React Three Fiber; it needs a direct library URL or canvas store marker. Bevy and raylib require both identifying names and runtime evidence. Roblox has no browser runtime rule. Bundles that hide names/globals, worker rendering, or unreadable canvases can remain unidentified. These are hints for maintainer review, not proof of the engine used.

`scripts/upload.mjs` runs separately with the upload credentials and treats the entire artifact as untrusted data. It only parses `engine.json` as JSON (regular files up to 64 KiB), accepts engine slugs from its checked-out `taxonomies/engines.yaml` (never a renderer slug), accepts `renderer` only as `webgpu`, `webgl` or `canvas`, and discards extra properties. Evidence is sanitized to printable ASCII, at most five nonempty strings of at most 80 characters each. Missing, invalid or unrecognized detections omit the field they would fill. Creator-supplied screenshots have no engine detection.

After all image variants upload successfully, `games/<slug>/ready.json` has this shape (the example has all three images):

```json
{
  "slug": "example-game",
  "files": 25,
  "names": ["cover", "shot-1", "shot-2"],
  "widths": [320, 640, 960, 1280],
  "engine": "phaser",
  "engineEvidence": ["window.Phaser.VERSION 3.80.1"],
  "renderer": "webgl"
}
```

`files` counts image variants, excluding the marker. `names` lists only captured images; partial captures have fewer names and variants. `engine` and `engineEvidence` are optional and appear together; a valid engine may have an empty evidence array. `renderer` is optional and independent of them. Older markers remain supported by the media audit, width backfill and recapture checks. A maintainer-reviewed pull request may fill an empty `tech.engine` from the detected engine, never from the renderer; an engine the entry already names is never replaced.

## License

The data is licensed under [CC BY 4.0](LICENSE). If you reuse it, credit "GamesByAI (gamesbyai.win)" with a link.
