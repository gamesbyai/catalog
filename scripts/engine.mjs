// Ordered across all frames: game engines before frameworks, then React shells. Renderers are reported separately.
// Roblox has no browser runtime to fingerprint. Other native engines need an identifiable web export.
const library = (name) => new RegExp(`(?:^|/)(?:${name})(?:[.@_-][^/]*)?\\.(?:m?js|wasm)(?:\\.(?:gz|br))?$`, 'i');
const RULES = [
  { engine: 'godot', globals: ['GODOT_CONFIG', 'Engine.prototype.startGame'], urls: library('godot') },
  { engine: 'unity', globals: ['createUnityInstance', 'UnityLoader'], urls: /(?:\.framework\.js|\/Build\/[^/]+\.loader\.js|\/UnityLoader\.js)(?:\.(?:gz|br|unityweb))?$/i },
  { engine: 'unreal', globals: ['UE4', 'UE4Game'], urls: library('UE4Game|UnrealEngine') },
  { engine: 'gamemaker', globals: ['GameMaker_Init', 'GM_getGamepads', 'g_pGMFile', 'YYG', 'yyInit'], urls: /\/(?:gamemaker(?:[._-][^/]*)?|gml(?:_Script)?[^/]*)\.js$/i },
  { engine: 'defold', globals: ['EngineLoader.load', 'dmEngine'], urls: library('dmloader|dmengine|defold') },
  { engine: 'construct', globals: ['C3', 'cr_createRuntime', 'C3_CreateRuntime'], urls: library('c3runtime|c2runtime|construct') },
  { engine: 'gdevelop', globals: ['gdjs'], urls: library('gdjs|gdevelop') },
  { engine: 'cocos', globals: ['cc.ENGINE_VERSION', 'CocosEngine'], urls: library('cocos2d|cocos') },
  { engine: 'rpg-maker', globals: ['Utils.RPGMAKER_NAME'], urls: library('rpg_core|rmmz_core') },
  { engine: 'renpy', globals: ['renpy', 'renpyWeb', 'renpy_exec', 'renpy_exc'], urls: library('renpy|renpyweb') },
  { engine: 'twine', globals: ['SugarCube', 'Harlowe'], dom: ['tw-story', 'tw-storydata'], urls: library('sugarcube|harlowe') },
  { engine: 'bitsy', globals: ['bitsy', 'startExportedGame'], urls: library('bitsy') },
  { engine: 'puzzlescript', globals: ['PuzzleScript'], urls: library('puzzlescript') },
  { engine: 'gb-studio', urls: library('gb-studio|gbstudio') },
  { engine: 'pico-8', globals: ['pico8_gpio', 'pico8_buttons', '_cartdat'], urls: library('pico8|pico-8') },
  { engine: 'tic-80', globals: ['TIC80'], urls: library('tic80|tic-80') },
  { engine: 'love2d', globals: ['Love'], urls: library('love') },
  { engine: 'pygame', globals: ['pygbag'], dom: ['pygbag loader'], urls: /(?:\/pygbag(?:\/[\w.-]+)*\/|\/pygbag[^/]*\.(?:js|wasm)$|\/pygame[^/]*\.wasm$)/i },
  { engine: 'bevy' },
  { engine: 'raylib' },
  { engine: 'monogame', globals: ['Microsoft.Xna.Framework'], urls: /\/monogame(?:[._-][^/]*)?\.(?:js|wasm|dll)$/i },
  { engine: 'libgdx', globals: ['libgdx', 'com.badlogic.gdx'], urls: library('libgdx') },
  { engine: 'flutter', globals: ['_flutter'], urls: library('flutter|flutter_bootstrap') },
  { engine: 'phaser', globals: ['Phaser.VERSION'], urls: library('phaser') },
  { engine: 'kaplay', globals: ['kaplay', 'kaboom'], urls: library('kaplay|kaboom') },
  { engine: 'excalibur', globals: ['ex.Engine'], urls: library('excalibur') },
  { engine: 'littlejs', globals: ['littlejs', 'engineInit'], urls: library('littlejs|little') },
  { engine: 'p5js', globals: ['p5'], urls: library('p5') },
  // Anchored and linear: an unanchored `\/.*` after each `/@react-three/fiber/` was quadratic in the path length.
  { engine: 'react-three-fiber', urls: /^(?=.*\.m?js$)(?:.*\/@react-three\/fiber(?:@[^/]+)?\/|.*\/react-three-fiber[^/]*$)/i },
  { engine: 'aframe', globals: ['AFRAME'], urls: library('aframe') },
  { engine: 'playcanvas', globals: ['pc.app', 'pc.Application'], urls: library('playcanvas') },
  { engine: 'babylonjs', globals: ['BABYLON'], urls: library('babylon|babylonjs') },
  { engine: 'threejs', globals: ['THREE', '__THREE__'], urls: library('three') },
  { engine: 'pixijs', globals: ['PIXI', '__PIXI_APP__'], urls: library('pixi|pixijs') },
  { engine: 'react', globals: ['React'], urls: library('react|react-dom') },
];

export const ENGINE_PRIORITY = RULES.map((r) => r.engine);
/**
 * How a page draws (a GPU canvas context with navigator.gpu, a live WebGL/WebGL2 context, a 2D canvas with drawn
 * pixels), not what it was made with: reported as `renderer`, never as the engine. Bundles of PixiJS, Babylon.js,
 * PlayCanvas, Excalibur or LittleJS often hide every name, so a renderer result is far more often a missed engine than
 * a game written on raw WebGL or canvas.
 */
export const RENDERERS = ['webgpu', 'webgl', 'canvas'];
/** Taxonomy engines with no browser runtime to fingerprint: they need no rule in RULES. */
export const NO_BROWSER_RUNTIME = ['roblox'];
export const ENGINE_GLOBALS = [...new Set([...RULES.flatMap((r) => r.globals ?? []),
  'wasm_bindgen', 'Module.HEAP8', 'Module.asm', 'HEAP8', 'compile', 'unloadGame',
  'loadLevelFromState', 'engineObjects', 'GBStudio',
])];
const clean = (s) => s.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80);

// What Node accepts from a page, whatever the page did to the probe: one JSON string per frame, at most MAX_FRAMES
// frames, and in each frame at most MAX_URLS script/asset URLs of up to MAX_URL characters (MAX_FRAME_URL_CHARS per
// frame, MAX_TOTAL_URL_CHARS across frames), known DOM and context tokens, and known global names with `true` or a
// string of up to MAX_VALUE characters. The probe itself stays well inside these.
export const MAX_EVIDENCE_JSON = 65536;
export const MAX_FRAMES = 64;
const MAX_URLS = 512;
const MAX_URL = 2048;
const MAX_FRAME_URL_CHARS = 65536;
const MAX_TOTAL_URL_CHARS = 262144;
const MAX_VALUE = 200;
const MAX_TOKENS = 256;
const DOM = ['tw-story', 'tw-storydata', 'pygbag loader', 'react-three-fiber'];

/** The frames as plain bounded data; anything else a page returned is dropped. */
export function boundFrames(frames) {
  let room = MAX_TOTAL_URL_CHARS;
  return (Array.isArray(frames) ? frames.slice(0, MAX_FRAMES) : []).map((frame) => {
    const f = frame && typeof frame === 'object' && !Array.isArray(frame) ? frame : {};
    const raw = f.globals && typeof f.globals === 'object' ? f.globals : {};
    const globals = {};
    for (const key of ENGINE_GLOBALS) {
      const value = Object.hasOwn(raw, key) ? raw[key] : undefined;
      if (value === true) globals[key] = true;
      else if (typeof value === 'string') globals[key] = value.slice(0, MAX_VALUE);
    }
    const urls = [];
    let frameRoom = MAX_FRAME_URL_CHARS;
    for (const u of Array.isArray(f.urls) ? f.urls.slice(0, MAX_URLS) : []) {
      if (!u || (u.kind !== 'script' && u.kind !== 'asset') || typeof u.url !== 'string' || u.url.length > MAX_URL) continue;
      if (u.url.length > frameRoom || u.url.length > room) break;
      frameRoom -= u.url.length;
      room -= u.url.length;
      urls.push({ kind: u.kind, url: u.url });
    }
    const tokens = (list, known) => (Array.isArray(list) ? known.filter((t) => list.slice(0, MAX_TOKENS).includes(t)) : []);
    return { globals, urls, dom: tokens(f.dom, DOM), contexts: tokens(f.contexts, RENDERERS) };
  });
}

/** Pure decision on bounded observations. Combined signatures must occur in the same frame. */
export function detectEngine(frames = []) {
  const matches = new Map();
  const drawn = new Set();
  for (const { globals, urls, dom, contexts } of boundFrames(frames)) {
    const has = (p) => Object.hasOwn(globals, p) && globals[p] !== false && globals[p] != null;
    const evidence = (p) => `window.${p}${typeof globals[p] === 'string' ? ` ${globals[p]}` : ''}`;
    const paths = urls.map((u) => {
      try { return { path: new URL(u.url, 'https://game.invalid').pathname, label: `${u.kind === 'script' ? 'script src' : 'asset'} ${u.url}` }; }
      catch { return { path: '', label: '' }; }
    });
    const found = (re) => paths.filter(({ path }) => re.test(path)).map(({ label }) => label);
    const add = (engine, items) => {
      if (items.length) matches.set(engine, [...(matches.get(engine) ?? []), ...items].map(clean).filter(Boolean).slice(0, 5));
    };
    for (const rule of RULES) {
      const gs = (rule.globals ?? []).filter(has).filter((p) => p !== 'Utils.RPGMAKER_NAME' || /^(MV|MZ)$/.test(globals[p]));
      // LittleJS's engineInit alone is an ordinary game function, not an identifying signature.
      add(rule.engine, [...gs.filter((p) => p !== 'engineInit' || has('engineObjects')).map(evidence),
        ...(rule.urls ? found(rule.urls) : []), ...(rule.dom ?? []).filter((d) => dom.includes(d)).map((d) => `element ${d}`)]);
    }
    const bevy = found(library('bevy'));
    if (bevy.length && (has('wasm_bindgen') || found(/_bg\.wasm$/i).length)) add('bevy', [...bevy, ...(has('wasm_bindgen') ? [evidence('wasm_bindgen')] : found(/_bg\.wasm$/i))]);
    const raylib = found(library('raylib'));
    if (raylib.length && ['Module.HEAP8', 'Module.asm', 'HEAP8'].some(has)) add('raylib', [...raylib, 'Emscripten runtime']);
    if (has('compile') && has('unloadGame') && has('loadLevelFromState')) add('puzzlescript', ['PuzzleScript compile + unloadGame + loadLevelFromState']);
    if (has('GBStudio') || (found(/\/binjgb(?:[.-][^/]*)?\.js$/i).length && found(/\/rom\/game\.gb$/i).length)) add('gb-studio', has('GBStudio') ? [evidence('GBStudio')] : ['binjgb.js + rom/game.gb']);
    if (dom.includes('react-three-fiber')) add('react-three-fiber', ['canvas React Three Fiber store']);
    for (const kind of contexts) drawn.add(kind);
  }
  const engine = ENGINE_PRIORITY.find((e) => matches.has(e)) ?? null;
  return { engine, renderer: RENDERERS.find((r) => drawn.has(r)) ?? null, evidence: engine ? [...new Set(matches.get(engine))].slice(0, 5) : [] };
}

/**
 * Installed before page code in every frame. Only native browser APIs and data descriptors are used to inspect it.
 * Every built-in the reader uses is saved here, before any page script runs, and called through Reflect.apply; its
 * lists and records have no prototype and are filled by index. So a page that replaces String, Array, RegExp, JSON or
 * NodeList methods (or adds toJSON or index setters to prototypes) can't change what is read or how much. The
 * immutable getter keeps the saved methods out of the page's reach and returns one JSON string, capped at
 * MAX_EVIDENCE_JSON characters; the probe's own output stays well below that. It never calls an engine method,
 * evaluates script text, or creates a context on a game canvas. Work and returned data are capped.
 */
export function installEngineProbe(paths) {
  try {
    const apply = Reflect.apply;
    const descriptor = Object.getOwnPropertyDescriptor;
    const own = Object.hasOwn;
    const has = Reflect.has;
    const define = Object.defineProperty;
    const unlink = Object.setPrototypeOf;
    const stringify = JSON.stringify;
    const slice = String.prototype.slice;
    const charCode = String.prototype.charCodeAt;
    const fromCharCode = String.fromCharCode;
    const now = performance.now.bind(performance);
    const query = document.querySelectorAll.bind(document);
    const count = descriptor(NodeList.prototype, 'length').get;
    const item = NodeList.prototype.item;
    const attr = Element.prototype.getAttribute;
    const resources = performance.getEntriesByType.bind(performance);
    const resourceName = descriptor(PerformanceEntry.prototype, 'name').get;
    const getContext = HTMLCanvasElement.prototype.getContext;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    const pixels = CanvasRenderingContext2D.prototype.getImageData;
    const pixelData = descriptor(ImageData.prototype, 'data').get;
    const connected = descriptor(Node.prototype, 'isConnected').get;
    const width = descriptor(HTMLCanvasElement.prototype, 'width').get;
    const setWidth = descriptor(HTMLCanvasElement.prototype, 'width').set;
    const height = descriptor(HTMLCanvasElement.prototype, 'height').get;
    const lost = WebGLRenderingContext.prototype.isContextLost;
    const lost2 = WebGL2RenderingContext.prototype.isContextLost;
    const gpu = descriptor(Navigator.prototype, 'gpu')?.get;
    const navigatorObject = navigator;
    const list = () => unlink([], null);
    // The global names, copied and split now, while String and Array methods are still the browser's own.
    const names = list();
    const keys = list();
    for (let i = 0; i < paths.length; i++) {
      names[i] = paths[i];
      keys[i] = paths[i].split('.');
    }
    const tracks = list();
    const read = (obj, key) => {
      try { const d = descriptor(obj, key); return d && own(d, 'value') ? d.value : undefined; } catch { return undefined; }
    };
    const add = (items, value) => {
      for (let i = 0; i < items.length; i++) if (items[i] === value) return;
      items[items.length] = value;
    };
    // Printable ASCII without quotes or backslashes (JSON adds no escapes), from the first n characters of s; a URL
    // ends at its query or fragment.
    const short = (s, n, url) => {
      if (typeof s !== 'string') return '';
      const head = apply(slice, s, [0, n]);
      let out = '';
      for (let i = 0; i < head.length; i++) {
        const c = apply(charCode, head, [i]);
        if (url && (c === 63 || c === 35)) break;
        if (c >= 32 && c <= 126 && c !== 34 && c !== 92) out += fromCharCode(c);
      }
      return out;
    };
    const scratch = document.createElement('canvas');
    scratch.width = scratch.height = 16;
    const sample = apply(getContext, scratch, ['2d', { willReadFrequently: true }]);
    define(HTMLCanvasElement.prototype, 'getContext', { configurable: true, writable: true, value: function (...args) {
      const context = apply(getContext, this, args);
      if (context && tracks.length < 32) {
        for (let i = 0; i < tracks.length; i++) if (tracks[i].canvas === this) return context;
        tracks[tracks.length] = { __proto__: null, canvas: this, context, kind: args[0] };
      }
      return context;
    } });
    define(window, '__catalogEngineEvidence', { get: () => {
      const result = { __proto__: null, globals: { __proto__: null }, urls: list(), dom: list(), contexts: list() };
      const until = now() + 30;
      let room = 48000; // URL characters plus 32 per entry keep the JSON well under MAX_EVIDENCE_JSON
      const keep = (kind, url) => {
        if (!url || url.length + 32 > room) return;
        room -= url.length + 32;
        result.urls[result.urls.length] = { __proto__: null, kind, url };
      };
      try {
        for (let i = 0; i < keys.length; i++) {
          if (now() > until) break;
          let value = window;
          for (let j = 0; j < keys[i].length; j++) value = read(value, keys[i][j]);
          if (value != null && value !== false) result.globals[names[i]] = typeof value === 'string' ? short(value, 80) : true;
        }
        // Godot's export template declares this as a top-level const, not a Window property.
        try { if (!has(window, 'GODOT_CONFIG') && typeof GODOT_CONFIG === 'object' && GODOT_CONFIG) result.globals.GODOT_CONFIG = true; } catch {}
        const scripts = query('script[src], link[rel="modulepreload"], link[rel="preload"]');
        const scriptCount = apply(count, scripts, []);
        for (let i = 0; i < scriptCount && i < 192 && now() < until; i++) {
          const element = apply(item, scripts, [i]);
          const src = apply(attr, element, ['src']);
          const url = short(src || apply(attr, element, ['href']), 1024, true);
          keep(src ? 'script' : 'asset', url);
          if (url.length >= 11 && apply(slice, url, [url.length - 11]) === '/pythons.js' && apply(attr, element, ['data-python']) && apply(attr, element, ['data-os'])) add(result.dom, 'pygbag loader');
        }
        const entries = resources('resource');
        for (let i = 0; i < entries.length && i < 256 && now() < until; i++) keep('asset', short(apply(resourceName, entries[i], []), 1024, true));
        if (apply(count, query('tw-story'), [])) add(result.dom, 'tw-story');
        if (apply(count, query('tw-storydata'), [])) add(result.dom, 'tw-storydata');
        const canvases = query('canvas');
        const canvasCount = apply(count, canvases, []);
        for (let i = 0; i < canvasCount && i < 32 && now() < until; i++) {
          const fiber = read(apply(item, canvases, [i]), '__r3f');
          if (read(fiber, 'root') || read(fiber, 'store')) add(result.dom, 'react-three-fiber');
        }
        for (let i = 0; i < tracks.length && now() < until; i++) {
          const { canvas, context, kind } = tracks[i];
          if (!apply(connected, canvas, []) || !apply(width, canvas, []) || !apply(height, canvas, [])) continue;
          try {
            if ((kind === 'webgl' || kind === 'experimental-webgl') && !apply(lost, context, [])) add(result.contexts, 'webgl');
            else if (kind === 'webgl2' && !apply(lost2, context, [])) add(result.contexts, 'webgl');
            else if (kind === 'webgpu' && gpu && apply(gpu, navigatorObject, [])) add(result.contexts, 'webgpu');
            else if (kind === '2d') {
              apply(setWidth, scratch, [16]); // also removes taint from a previous cross-origin canvas
              apply(draw, sample, [canvas, 0, 0, 16, 16]);
              const data = apply(pixelData, apply(pixels, sample, [0, 0, 16, 16]), []);
              for (let j = 3; j < 1024; j += 4) if (data[j]) { add(result.contexts, 'canvas'); break; }
            }
          } catch {} // Tainted canvases and lost contexts are inconclusive.
        }
      } catch {} // A detached document or a hostile descriptor must not fail capture.
      try { return apply(slice, stringify(result), [0, 65536]); } catch { return ''; }
    } });
  } catch {} // An unavailable API leaves detection empty, without changing capture's outcome.
}

// Self-contained for Playwright serialization. The getter was installed by our init script, not by the game; a frame
// the init script missed may define its own, so only a string within the cap ever leaves the page.
export function readEngineEvidence() {
  try {
    const value = window.__catalogEngineEvidence;
    return typeof value === 'string' && value.length <= 65536 ? value : '';
  } catch { return ''; }
}

/**
 * Every frame (up to MAX_FRAMES) gets a chance; one hung/detached frame cannot delay the others or capture by more than
 * the budget. The wait also ends when `signal` aborts (capture uses it to stop reading at its end), with the frames
 * that answered by then. Only a JSON string within MAX_EVIDENCE_JSON is parsed, and detectEngine bounds what it holds.
 */
// itch.io's own game page (around the game's itch.zone frame) loads its site scripts, React among them: reading it
// would credit every itch.io game to React. Only the game's frames count.
const hostPage = (frame) => {
  try {
    const host = new URL(frame.url()).hostname;
    return host === 'itch.io' || host.endsWith('.itch.io');
  } catch { return false; }
};

export async function detectPageEngine(page, budget = 750, signal) {
  const frames = [];
  let timer;
  let end;
  try {
    await Promise.race([
      Promise.all(page.frames().filter((frame) => !hostPage(frame)).slice(0, MAX_FRAMES).map((frame) => frame.evaluate(readEngineEvidence).then((data) => {
        if (typeof data === 'string' && data.length <= MAX_EVIDENCE_JSON) frames.push(data);
      }).catch(() => {}))),
      new Promise((resolve) => {
        timer = setTimeout(resolve, budget);
        end = resolve;
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', end, { once: true });
      }),
    ]);
    return detectEngine(frames.slice(0, MAX_FRAMES).map((data) => { try { return JSON.parse(data); } catch { return {}; } }));
  } catch { return { engine: null, renderer: null, evidence: [] }; }
  finally {
    clearTimeout(timer);
    if (end) signal?.removeEventListener('abort', end);
  }
}
