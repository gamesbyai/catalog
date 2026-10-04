import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { detectEngine, detectPageEngine, boundFrames, ENGINE_PRIORITY, ENGINE_GLOBALS, RENDERERS, NO_BROWSER_RUNTIME, MAX_EVIDENCE_JSON, MAX_FRAMES } from '../scripts/engine.mjs';

const globals = (values) => ({ globals: values });
const urls = (...values) => ({ urls: values.map((url) => ({ kind: 'script', url })) });
const engine = (...frames) => detectEngine(frames).engine;
const renderer = (...frames) => detectEngine(frames).renderer;

test('recognizes engine globals without needing a browser', () => {
  const cases = [
    ['threejs', 'THREE'], ['threejs', '__THREE__'], ['babylonjs', 'BABYLON'], ['playcanvas', 'pc.app'],
    ['aframe', 'AFRAME'], ['phaser', 'Phaser.VERSION', '3.80.1'], ['pixijs', 'PIXI'], ['pixijs', '__PIXI_APP__'],
    ['kaplay', 'kaplay'], ['kaplay', 'kaboom'], ['excalibur', 'ex.Engine'], ['littlejs', 'littlejs'], ['p5js', 'p5'],
    ['godot', 'GODOT_CONFIG'], ['godot', 'Engine.prototype.startGame'], ['unity', 'createUnityInstance'], ['unity', 'UnityLoader'],
    ['unreal', 'UE4Game'], ['gamemaker', 'GameMaker_Init'], ['gamemaker', 'g_pGMFile'], ['defold', 'EngineLoader.load'],
    ['construct', 'C3'], ['construct', 'C3_CreateRuntime'], ['gdevelop', 'gdjs'], ['cocos', 'cc.ENGINE_VERSION'],
    ['love2d', 'Love'], ['pygame', 'pygbag'], ['pico-8', '_cartdat'], ['pico-8', 'pico8_gpio'], ['tic-80', 'TIC80'],
    ['rpg-maker', 'Utils.RPGMAKER_NAME', 'MV'], ['rpg-maker', 'Utils.RPGMAKER_NAME', 'MZ'],
    ['twine', 'SugarCube'], ['twine', 'Harlowe'], ['renpy', 'renpy'], ['bitsy', 'bitsy'], ['puzzlescript', 'PuzzleScript'],
    ['gb-studio', 'GBStudio'], ['flutter', '_flutter'], ['react', 'React'], ['monogame', 'Microsoft.Xna.Framework'], ['libgdx', 'libgdx'],
  ];
  for (const [expected, path, value = true] of cases) assert.equal(engine(globals({ [path]: value })), expected, path);
  assert.deepEqual(detectEngine([globals({ 'Phaser.VERSION': '3.80.1' })]), { engine: 'phaser', renderer: null, evidence: ['window.Phaser.VERSION 3.80.1'] });
});

test('recognizes script and asset paths, including module builds and named web exports', () => {
  const cases = {
    threejs: 'three.module.min.js', babylonjs: 'babylon.js', playcanvas: 'playcanvas-stable.min.js', aframe: 'aframe.min.js',
    'react-three-fiber': '@react-three/fiber@9.0.0/dist/react-three-fiber.esm.js', phaser: 'phaser-3.80.min.js', pixijs: 'pixi.min.js',
    kaplay: 'kaboom.js', excalibur: 'excalibur.min.js', littlejs: 'littlejs.release.js', p5js: 'p5.min.js', godot: 'godot.js',
    unity: 'Build/game.loader.js', unreal: 'UE4Game.wasm', gamemaker: 'gml_Script_game.js', defold: 'dmloader.js',
    construct: 'c3runtime.js', gdevelop: 'gdjs.js', cocos: 'cocos2d-js-min.js', 'rpg-maker': 'rmmz_core.js',
    renpy: 'renpy.js', twine: 'sugarcube.js', bitsy: 'bitsy.js', puzzlescript: 'puzzlescript.js', 'gb-studio': 'gbstudio.js',
    'pico-8': 'pico8.js', 'tic-80': 'tic80.js', love2d: 'love.js', pygame: 'pygbag/0.9/pythons.js',
    monogame: 'MonoGame.Framework.dll', libgdx: 'libgdx.js', flutter: 'flutter_bootstrap.js', react: 'react.production.min.js',
  };
  for (const [expected, path] of Object.entries(cases)) assert.equal(engine(urls(`https://cdn.example/${path}?v=1`)), expected, path);
  assert.equal(engine(urls('/Build/game.framework.js.br')), 'unity');
  assert.equal(engine(urls('/game.pck', '/godot.js')), 'godot');
  assert.equal(engine({ urls: [{ kind: 'asset', url: '/three.module.js' }] }), 'threejs');
  for (const path of ['/@react-three/fiber/dist/index.js', '/x/@react-three/fiber/a/b.mjs', '/a/react-three-fiber-2.mjs']) assert.equal(engine(urls(path)), 'react-three-fiber', path);
  for (const path of ['/react-three-fiber/index.js', '/@react-three/fiberx/a.js', '/@react-three/fiber@1/a.jsx', '/@react-three/fiber.js']) assert.notEqual(engine(urls(path)), 'react-three-fiber', path);
});

test('combined signatures require direct evidence in one frame', () => {
  assert.equal(engine({ ...urls('/bevy_game.js'), ...globals({ wasm_bindgen: true }) }), 'bevy');
  assert.equal(engine(urls('/bevy_game.js', '/game_bg.wasm')), 'bevy');
  assert.equal(engine({ ...urls('/raylib.js'), ...globals({ 'Module.HEAP8': true }) }), 'raylib');
  assert.equal(engine(globals({ engineInit: true, engineObjects: true })), 'littlejs');
  assert.equal(engine(globals({ compile: true, unloadGame: true, loadLevelFromState: true })), 'puzzlescript');
  assert.equal(engine(urls('/binjgb.js', '/rom/game.gb')), 'gb-studio');
  assert.equal(engine({ dom: ['tw-story'] }), 'twine');
  assert.equal(engine({ dom: ['pygbag loader'] }), 'pygame');
  assert.equal(engine({ dom: ['react-three-fiber'] }), 'react-three-fiber');
  for (const frame of [globals({ Engine: true }), globals({ engineInit: true }), globals({ navigator: true }),
    globals({ 'Utils.RPGMAKER_NAME': 'Other' }), urls('/game.pck'), urls('/bevy.js'), urls('/raylib.js'), urls('/binjgb.js'),
    urls('/runner.js'), urls('/game.nocache.js'), urls('/game.js?engine=phaser'), urls('https://threejs.example/game.js')]) {
    assert.equal(engine(frame), null, JSON.stringify(frame));
  }
  assert.equal(engine(globals({ wasm_bindgen: true }), urls('/bevy.js')), null, 'unrelated frames do not form a signature');
  assert.equal(engine(globals({ React: true, THREE: true })), 'threejs', 'React plus Three does not establish R3F');
});

test('priority is stable across frames and puts engines above frameworks and React shells', () => {
  for (const [higher, lower] of [['GODOT_CONFIG', 'THREE'], ['createUnityInstance', 'PIXI'], ['C3', 'THREE'],
    ['Phaser.VERSION', 'PIXI'], ['Utils.RPGMAKER_NAME', 'PIXI'], ['AFRAME', 'THREE'], ['gdjs', 'React']]) {
    const a = globals({ [higher]: higher === 'Utils.RPGMAKER_NAME' ? 'MZ' : true });
    const b = globals({ [lower]: true });
    assert.equal(engine(a, b), engine(a));
    assert.equal(engine(b, a), engine(a));
  }
  assert.equal(engine(urls('/@react-three/fiber/dist/index.js'), globals({ THREE: true })), 'react-three-fiber');
  assert.deepEqual(detectEngine([{}]), { engine: null, renderer: null, evidence: [] });
});

test('a renderer is reported apart from the engine and is never the engine', () => {
  for (const contexts of [['webgl'], ['webgpu'], ['canvas'], ['canvas', 'webgl', 'webgpu']]) {
    assert.deepEqual(detectEngine([{ contexts }]), { engine: null, renderer: RENDERERS.find((r) => contexts.includes(r)), evidence: [] }, String(contexts));
  }
  assert.equal(renderer({ contexts: ['canvas'] }, { contexts: ['webgl'] }), 'webgl', 'the best renderer across frames');
  assert.deepEqual(detectEngine([globals({ 'Phaser.VERSION': '3' }), { contexts: ['webgpu', 'webgl', 'canvas'] }]),
    { engine: 'phaser', renderer: 'webgpu', evidence: ['window.Phaser.VERSION 3'] });
  assert.equal(renderer(globals({ THREE: true })), null);
  for (const r of RENDERERS) assert.ok(!ENGINE_PRIORITY.includes(r), r);
});

test('every engine slug with a rule exists in the taxonomy; a taxonomy engine without one only warns', (t) => {
  const taxonomy = parse(readFileSync(new URL('../taxonomies/engines.yaml', import.meta.url), 'utf8')).terms.map((term) => term.slug);
  const unknown = [...ENGINE_PRIORITY, ...RENDERERS, ...NO_BROWSER_RUNTIME].filter((slug) => !taxonomy.includes(slug));
  assert.deepEqual(unknown, [], `scripts/engine.mjs names engines that taxonomies/engines.yaml lacks: ${unknown.join(', ')} (add the term there, or fix the slug in scripts/engine.mjs)`);
  // A content or seed PR may add an engine term before anyone writes its detection rule: CI warns, it doesn't fail.
  const unruled = taxonomy.filter((slug) => ![...ENGINE_PRIORITY, ...RENDERERS, ...NO_BROWSER_RUNTIME].includes(slug));
  if (unruled.length) t.diagnostic(`no detection rule yet for ${unruled.join(', ')}: add a rule in scripts/engine.mjs or list it in NO_BROWSER_RUNTIME`);
});

test('detected evidence is bounded printable ASCII, with no arbitrary extra fields', () => {
  const result = detectEngine(Array.from({ length: 20 }, (_, i) => globals({ 'Phaser.VERSION': `${i} ${'a'.repeat(200)}\n\u0000☃` })));
  assert.equal(result.engine, 'phaser');
  assert.equal(result.evidence.length, 5);
  assert.ok(result.evidence.every((s) => /^[\x20-\x7e]{1,80}$/.test(s)));
});

test('whatever a page returns, detection keeps bounded data and finishes quickly', () => {
  // Paths that made the old react-three-fiber rule quadratic, far more frames and URLs than any page needs, unknown
  // globals and tokens, and values of the wrong type.
  const slow = `/${'@react-three/fiber/'.repeat(107)}x`;
  const frame = {
    globals: { ...Object.fromEntries(ENGINE_GLOBALS.map((g) => [g, 'v'.repeat(100000)])), unknown: true, THREE: { nested: 'x' } },
    urls: [{ kind: 'script', url: 'x'.repeat(5000) }, { kind: 'evil', url: '/three.js' }, 'string', null, ...Array(20000).fill({ kind: 'script', url: slow })],
    dom: Array(100000).fill('tw-story').concat(['injected']),
    contexts: Array(100000).fill('webgl').concat(['webgl3']),
    extra: 'x'.repeat(100000),
  };
  const frames = Array(5000).fill(frame);
  const bounded = boundFrames(frames);
  assert.equal(bounded.length, MAX_FRAMES);
  assert.ok(bounded.every((f) => f.urls.length <= 512 && f.urls.every((u) => u.url.length <= 2048 && ['script', 'asset'].includes(u.kind))));
  assert.ok(bounded.reduce((n, f) => n + f.urls.reduce((m, u) => m + u.url.length, 0), 0) <= 262144, 'URL characters across frames');
  assert.ok(bounded.every((f) => Object.keys(f.globals).every((g) => ENGINE_GLOBALS.includes(g) && (f.globals[g] === true || f.globals[g].length <= 200))));
  assert.deepEqual(Object.keys(bounded[0]).sort(), ['contexts', 'dom', 'globals', 'urls']);
  assert.deepEqual(bounded[0].dom, ['tw-story']);
  assert.deepEqual(bounded[0].contexts, ['webgl']);
  assert.equal(bounded[0].globals.PIXI.length, 200);
  assert.equal(bounded[0].globals.THREE, undefined, 'an object value is dropped');
  assert.equal(bounded[0].globals.unknown, undefined, 'an unknown global is dropped');
  const started = performance.now();
  const result = detectEngine(frames);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
  assert.equal(result.engine, 'godot');
  assert.equal(result.renderer, 'webgl');
  assert.ok(result.evidence.length <= 5 && result.evidence.every((s) => s.length <= 80));
  for (const junk of [null, 'frames', 42, { length: 1e9 }, [null, 7, 'x', [[]]]]) assert.deepEqual(detectEngine(junk), { engine: null, renderer: null, evidence: [] });
});

test('every frame is checked under one budget, even if another frame hangs or detaches', async () => {
  let calls = 0;
  const frame = (answer) => ({ evaluate: () => { calls++; return answer; } });
  const phaser = JSON.stringify(globals({ 'Phaser.VERSION': '3.80.1' }));
  const page = { frames: () => [frame(new Promise(() => {})), frame(Promise.reject(new Error('detached'))), frame(Promise.resolve(phaser))] };
  const result = await detectPageEngine(page, 20);
  assert.equal(calls, 3);
  assert.equal(result.engine, 'phaser');
  assert.deepEqual(await detectPageEngine({ frames: () => { throw new Error('closed'); } }), { engine: null, renderer: null, evidence: [] });
});

test('a scan with a long budget ends when its signal does, with the frames that answered by then', async () => {
  const phaser = JSON.stringify(globals({ 'Phaser.VERSION': '3.80.1' }));
  const page = { frames: () => [{ evaluate: () => new Promise(() => {}) }, { evaluate: async () => phaser }] };
  const end = new AbortController();
  const started = performance.now();
  const scan = detectPageEngine(page, 60_000, end.signal);
  setTimeout(() => end.abort(), 50);
  assert.equal((await scan).engine, 'phaser');
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
  const late = performance.now();
  await detectPageEngine(page, 60_000, end.signal);
  assert.ok(performance.now() - late < 1000, 'a scan started after the end returns at once');
});

test("itch.io's own page around the game frame is never read (it loads React for its site)", async () => {
  const frame = (url, answer) => ({ url: () => url, evaluate: async () => answer });
  const react = JSON.stringify(globals({ React: true }));
  const page = { frames: () => [frame('https://maker.itch.io/game', react), frame('https://html-classic.itch.zone/html/1/index.html', JSON.stringify(globals({})))] };
  assert.equal((await detectPageEngine(page, 50)).engine, null);
  const elsewhere = { frames: () => [frame('https://game.example.com/', react)] };
  assert.equal((await detectPageEngine(elsewhere, 50)).engine, 'react');
});

test('only a JSON string within the cap is read from a frame, and from at most 64 frames', async () => {
  let calls = 0;
  const frame = (answer) => ({ evaluate: async () => { calls++; return answer; } });
  const three = JSON.stringify(globals({ THREE: true }));
  const page = { frames: () => [
    frame(globals({ 'Phaser.VERSION': '3' })), // an object, not the probe's string
    frame(JSON.stringify({ globals: { GODOT_CONFIG: true }, pad: 'x'.repeat(MAX_EVIDENCE_JSON) })), // over the cap
    frame('{not json'), frame(42), frame(null),
    ...Array(1000).fill(frame(three)),
  ] };
  const started = performance.now();
  const result = await detectPageEngine(page, 200);
  assert.ok(performance.now() - started < 1000);
  assert.equal(calls, MAX_FRAMES);
  assert.equal(result.engine, 'threejs');
});
