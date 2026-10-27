import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createGame, observe } from '../src/game/engine';
import { mountRoomGame } from '../src/client/game/RoomScene';
import { ARTWORK, KITCHEN_ART } from '../src/client/game/assets';
import { approachFor, isWalkable } from '../src/game/navigation';
import type { GameSnapshot, PotPhase, SemanticAction } from '../src/shared/contracts';

type DisplayObject = { kind: string; active: boolean; depth: number; x: number; y: number;
  originX: number; originY: number; displayWidth: number; displayHeight: number; textureKey?: string; visible: boolean;
  frame?: string; rotation: number; flipX: boolean; scaleX: number; scaleY: number;
  mask?: { destroyed: boolean } };
type SceneView = { create(): void; update(time: number): void; events: EventEmitter;
  pointer(point: {x:number;y:number}): void;
  cameras: { main: { scrollX: number; scrollY: number } };
  displayObjects: DisplayObject[]; textureKeys: Set<string>;
  generated: Array<{ key: string; width: number; height: number; commands: number }> };
const harness = vi.hoisted(() => ({ scenes: [] as SceneView[], uuid: 0, artwork: [] as string[] }));

// Phaser needs a browser canvas. Keep only its scene/display-list boundary headless;
// RoomScene.create, snapshot handling, update and cleanup remain the real code.
vi.mock('phaser', async () => {
  const { EventEmitter } = await import('node:events');
  class Scene {
    events = new EventEmitter();
    displayObjects: DisplayObject[] = [];
    textureKeys = new Set<string>(harness.artwork);
    generated: SceneView['generated'] = [];
    textures = { exists: (key: string) => this.textureKeys.has(key),
      get: () => ({ has: () => false, add() {} }),
      remove: (key: string) => { this.textureKeys.delete(key); } };
    cameras = { main: { scrollX: 0, scrollY: 0, setBackgroundColor() {},
      setScroll(x: number, y: number) { this.scrollX=x; this.scrollY=y; return this; },
      getWorldPoint(x:number,y:number) { return {x:x+this.scrollX,y:y+this.scrollY}; } } };
    input = { on() {}, off() {} };
    tweens = { killTweensOf() {}, add() {} };
    time = { delayedCall: () => ({ remove() {} }) };
    add = Object.fromEntries(['graphics', 'image', 'grid', 'circle', 'ellipse', 'text', 'star'].map(kind =>
      [kind, (...args: unknown[]) => this.object(kind, args)]));
    make = { graphics: () => this.object('mask-graphics', []) };
    constructor() {
      // Phaser's display list is cleared on both scene lifecycle exits.
      for (const event of ['shutdown', 'destroy']) this.events.on(event, () => {
        for (const object of this.displayObjects) object.active = false;
      });
    }
    private object(kind: string, args: unknown[]) {
      const value: DisplayObject = { kind, active: true, depth: 0, x: Number(args[0] ?? 0), y: Number(args[1] ?? 0),
        originX: 0.5, originY: 0.5, displayWidth: 0, displayHeight: 0, visible: true,
        textureKey: kind === 'image' ? String(args[2]) : undefined,
        frame: kind === 'image' ? String(args[3]) : undefined, rotation: 0, flipX: false, scaleX: 1, scaleY: 1 };
      this.displayObjects.push(value);
      let commands = 0;
      const proxy: object = new Proxy(value, { get: (target, property) => {
        if (property in target) return target[property as keyof typeof target];
        return (...values: unknown[]) => {
          if (property === 'createGeometryMask') return { destroyed: false, destroy() { this.destroyed=true; } };
          if (property === 'destroy') target.active = false;
          else if (property === 'setMask') target.mask = values[0] as DisplayObject['mask'];
          else if (property === 'setDepth') target.depth = Number(values[0]);
          else if (property === 'setPosition') { target.x = Number(values[0]); target.y = Number(values[1]); }
          else if (property === 'setOrigin') { target.originX = Number(values[0]); target.originY = Number(values[1] ?? values[0]); }
          else if (property === 'setDisplaySize') { target.displayWidth = Number(values[0]); target.displayHeight = Number(values[1]); }
          else if (property === 'setTexture') { target.textureKey = String(values[0]); target.frame = String(values[1]); }
          else if (property === 'setRotation') target.rotation = Number(values[0]);
          else if (property === 'setFlipX') target.flipX = Boolean(values[0]);
          else if (property === 'setScale') { target.scaleX = Number(values[0]); target.scaleY = Number(values[1] ?? values[0]); }
          else if (property === 'setVisible') target.visible = Boolean(values[0]);
          else if (property === 'generateTexture') {
            const key = String(values[0]);
            if (this.textureKeys.has(key)) throw new Error('duplicate texture key');
            this.textureKeys.add(key);
            this.generated.push({ key, width: Number(values[1]), height: Number(values[2]), commands });
          } else if (property === 'clear') commands = 0;
          else commands++;
          return proxy;
        };
      } });
      return proxy;
    }
  }
  class Game {
    events = new EventEmitter();
    scene: SceneView;
    constructor(config: { scene: SceneView[]; callbacks: { postBoot(game: unknown): void } }) {
      this.scene = config.scene[0]; harness.scenes.push(this.scene); this.scene.create();
      config.callbacks.postBoot({ events: this.events, scene: { getScene: () => this.scene } });
    }
    destroy() { this.scene.events.emit('shutdown'); this.scene.events.emit('destroy'); }
  }
  return { default: { Scene, Game, AUTO: 0, Scale: { FIT: 0, CENTER_BOTH: 0 },
    Scenes: { Events: { SHUTDOWN: 'shutdown', DESTROY: 'destroy' } },
    Core: { Events: { PRE_STEP: 'prestep', POST_RENDER: 'postrender' } },
    Utils: { String: { UUID: () => `test-${++harness.uuid}` } },
    Math: { Clamp: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)),
      Distance: { BetweenPoints: (a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(a.x-b.x,a.y-b.y) } } } };
});

const mounted: ReturnType<typeof mountRoomGame>[] = [];
function mount(onIntent: (action: SemanticAction)=>void = () => {}) {
  const game = mountRoomGame({ replaceChildren() {} } as unknown as HTMLElement, onIntent);
  mounted.push(game);
  return { game, scene: harness.scenes[harness.scenes.length - 1] };
}
function clickWorld(scene: SceneView, point: {x:number;y:number}) {
  scene.pointer({x:point.x-scene.cameras.main.scrollX,y:point.y-scene.cameras.main.scrollY});
}
beforeEach(() => vi.stubGlobal('window', {}));
afterEach(() => { for (const game of mounted.splice(0)) game.destroy(); harness.scenes.length = 0; harness.artwork = []; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('static kitchen rendering lifecycle', () => {
  it('routes clicks on projected cabinet faces and upper table lips to reachable approaches', () => {
    const actions: SemanticAction[] = [];
    const {game,scene}=mount(action=>actions.push(action));
    const snapshot=observe(createGame(1000),'human').snapshot;
    snapshot.phase='playing';
    game.setSnapshot(snapshot);game.setActionsEnabled(true);
    for(const point of [{x:400,y:310},{x:96,y:55},{x:704,y:55}]) {
      clickWorld(scene, point);
      const action=actions.at(-1)!;
      expect(action.type).toBe('move_to');
      if(action.type==='move_to') {
        expect(action.target).not.toEqual(point);
        expect(isWalkable(action.target)).toBe(true);
      }
    }
  });
  it('resolves the visible cream carton to its real approach while preserving ground coordinates', () => {
    const actions: SemanticAction[]=[];
    const {game,scene}=mount(action=>actions.push(action));
    const snapshot=observe(createGame(1000),'human').snapshot;
    snapshot.phase='playing';
    game.setSnapshot(snapshot);game.setActionsEnabled(true);
    // The top of the recentered carton is above the old WORLD nearest-target boundary.
    clickWorld(scene,{x:96,y:302});
    expect(actions.at(-1)).toEqual({type:'move_to',target:approachFor(snapshot.seats.human.position,'source_cream')});
    clickWorld(scene,{x:230,y:250});
    expect(actions.at(-1)).toEqual({type:'move_to',target:{x:230,y:250}});
    const count=actions.length;
    clickWorld(scene,{x:400,y:-14});
    expect(actions).toHaveLength(count);
  });

  it('aligns stock and placed bowls on the same tabletop and supports pots on the stove surface', () => {
    harness.artwork=Object.values(KITCHEN_ART).map(art=>art.key);
    const {game,scene}=mount();
    const snapshot=observe(createGame(1000),'human').snapshot;
    snapshot.items.testBowl={id:'testBowl',kind:'plate',contents:[],recipe_id:null};
    snapshot.slots.plates='testBowl';
    game.setSnapshot(snapshot);
    const stock=scene.displayObjects.find(o=>o.textureKey===KITCHEN_ART['bowl-stack'].key)!;
    const bowl=scene.displayObjects.find(o=>o.textureKey===KITCHEN_ART['bowl-empty'].key)!;
    expect(bowl.x).toBe(stock.x);expect(bowl.y).toBe(stock.y);
    expect(stock.y).toBeLessThan(430);
    const stockBottom=stock.y+(1-stock.originY)*stock.displayHeight;
    expect(stockBottom).toBeLessThan(450);
    const stoves=scene.displayObjects.filter(o=>o.textureKey===KITCHEN_ART['prop-stove-empty'].key);
    const pots=scene.displayObjects.filter(o=>o.textureKey===KITCHEN_ART['pot-empty'].key);
    expect(stoves).toHaveLength(2);expect(pots).toHaveLength(2);
    for(let i=0;i<2;i++) {
      expect(pots[i].x).toBe(stoves[i].x);
      expect(pots[i].y).toBeLessThan(stoves[i].y);
      expect(pots[i].displayWidth).toBeLessThan(stoves[i].displayWidth);
    }
  });

  it('leaves headroom for enlarged characters without moving their feet or world targets', () => {
    harness.artwork=[ARTWORK.kitchen.key,ARTWORK.characters.key];
    const {game,scene}=mount();
    const snapshot=observe(createGame(1000),'human').snapshot;
    snapshot.seats.human.position={x:220,y:26};
    snapshot.seats.ai.position={x:600,y:26};
    game.setSnapshot(snapshot);scene.update(0);
    const people=scene.displayObjects.filter(o=>o.textureKey===ARTWORK.characters.key&&o.visible);
    expect(people).toHaveLength(2);
    for(const person of people) {
      expect(person.y).toBe(44);
      expect(person.y-person.displayHeight-scene.cameras.main.scrollY).toBeGreaterThanOrEqual(0);
    }
  });

  it('renders masked foreground stone above cabinet faces and releases its masks on shutdown', () => {
    harness.artwork=[ARTWORK.kitchen.key,...Object.values(KITCHEN_ART).map(art=>art.key)];
    const {game,scene}=mount();
    const foreground=scene.displayObjects.filter(o=>o.textureKey===ARTWORK.kitchen.key&&o.depth>25);
    expect(foreground.length).toBeGreaterThan(0);
    for(const stone of foreground)expect(stone.mask).toBeDefined();
    const masks=foreground.map(o=>o.mask!);
    game.destroy();
    expect(foreground.every(o=>!o.active)).toBe(true);
    expect(masks.every(mask=>mask.destroyed)).toBe(true);
  });
  it('keeps fixed counter paths out of the frame display list and displays one correctly sized baked image', () => {
    const { game, scene } = mount();
    expect(scene.displayObjects.filter(object => object.active && object.kind === 'graphics' && object.depth === 10),
      'fixed counter Graphics would replay every render frame').toEqual([]);
    const layers = scene.displayObjects.filter(object => object.active && object.kind === 'image' && object.depth === 10);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ x: 0, y: 0, originX: 0, originY: 0, displayWidth: 800, displayHeight: 500 });
    expect(scene.generated).toEqual([{ key: layers[0].textureKey, width: 800, height: 500, commands: expect.any(Number) }]);
    expect(scene.generated[0].commands).toBeGreaterThan(50);
    game.setSnapshot(observe(createGame(1000), 'human').snapshot);
    for (let frame = 0; frame < 60; frame++) scene.update(frame * 16);
    expect(scene.generated).toHaveLength(1);
  });

  it('releases only its baked texture on shutdown and rebuilds without key conflicts on the same scene', () => {
    const { scene } = mount();
    expect(scene.generated).toHaveLength(1);
    const firstKey = scene.generated[0].key;
    scene.textureKeys.add('unrelated-artwork');
    scene.events.emit('shutdown');
    expect([...scene.textureKeys]).toEqual(['unrelated-artwork']);
    expect(scene.displayObjects.filter(object => object.active)).toEqual([]);
    scene.create();
    expect(scene.generated).toHaveLength(2);
    expect(scene.textureKeys.has(scene.generated[1].key)).toBe(true);
    expect(scene.displayObjects.filter(object => object.active && object.kind === 'image' && object.depth === 10)).toHaveLength(1);
    scene.events.emit('destroy');
    expect(scene.textureKeys.has(firstKey)).toBe(false);
    expect([...scene.textureKeys]).toEqual(['unrelated-artwork']);
  });

  it('uses continuous side counters and keeps the two handoff items on their cloth pads', () => {
    harness.artwork = [ARTWORK.kitchen.key, ...Object.values(KITCHEN_ART).map(art => art.key),
      'kitchen-v3-cabinet-supply-vertical', 'kitchen-v3-cabinet-cooking-vertical', 'kitchen-v3-island-two-slot-empty'];
    const { game, scene } = mount();
    expect(scene.displayObjects.find(object => object.textureKey === ARTWORK.kitchen.key)).toMatchObject({ x: 0, y: -64, displayWidth: 800, displayHeight: 564 });
    expect(scene.displayObjects.filter(object => object.textureKey === KITCHEN_ART['counter-empty'].key)).toHaveLength(0);
    expect(scene.displayObjects.filter(object => object.textureKey === 'kitchen-v3-cabinet-supply-vertical')).toHaveLength(1);
    expect(scene.displayObjects.filter(object => object.textureKey === 'kitchen-v3-cabinet-cooking-vertical')).toHaveLength(1);
    const island = scene.displayObjects.filter(object => object.textureKey === 'kitchen-v3-island-two-slot-empty');
    expect(island).toHaveLength(1);
    expect(island[0]).toMatchObject({ x: 350, y: 140, originX: 0, originY: 0, displayWidth: 100 });
    const s = observe(createGame(1000), 'human').snapshot;
    s.items.foodA = {id:'foodA',kind:'ingredient',ingredient:'cucumber',preparation:'chopped',chop_remaining_ms:0};
    s.items.foodB = {id:'foodB',kind:'ingredient',ingredient:'pumpkin',preparation:'cooked',chop_remaining_ms:0};
    s.slots.handoff_a='foodA'; s.slots.handoff_b='foodB';
    game.setSnapshot(s);
    const upper=scene.displayObjects.find(object=>object.textureKey===KITCHEN_ART['cucumber-chopped'].key)!;
    const lower=scene.displayObjects.find(object=>object.textureKey===KITCHEN_ART['pumpkin-cooked'].key)!;
    expect(upper.x).toBe(400); expect(upper.y).toBeCloseTo(184,0);
    expect(lower.x).toBe(400); expect(lower.y).toBeCloseTo(254,0);
    s.seats.human.position={x:400,y:116}; s.state_version++;s.server_time_ms+=50;
    game.setSnapshot(s);scene.update(16);
    const human=scene.displayObjects.find(object=>object.kind==='circle'&&object.active)!;
    expect(human.depth).toBeLessThan(island[0].depth);
    s.seats.human.position={x:400,y:324};s.state_version++;s.server_time_ms+=50;
    game.setSnapshot(s);scene.update(32);
    expect(human.depth).toBeGreaterThan(island[0].depth);
  });

  it('reuses one image through material changes, follows held poses and releases removed items', () => {
    harness.artwork = Object.values(KITCHEN_ART).map(art => art.key);
    const { game, scene } = mount();
    const s: GameSnapshot = observe(createGame(1000), 'human').snapshot;
    for (const id of Object.keys(s.slots) as Array<keyof typeof s.slots>) s.slots[id] = null;
    s.items = { pot: { id: 'pot', kind: 'pot', contents: [], phase: 'empty', remaining_ms: 0 } };
    s.slots.burner_a = 'pot';
    const send = () => { s.state_version++; s.server_time_ms += 50; game.setSnapshot(structuredClone(s)); };
    send();
    const sprite = scene.displayObjects.find(object => object.kind === 'image' && object.depth === 25)!;
    const initialCount = scene.displayObjects.length;
    for (const phase of ['loaded_pumpkin', 'cooking_pumpkin', 'cooked_pumpkin', 'loaded_soup', 'cooking_soup', 'soup_ready'] satisfies PotPhase[]) {
      if (s.items.pot.kind === 'pot') s.items.pot.phase = phase;
      send();
    }
    expect(sprite.textureKey).toBe(KITCHEN_ART['pot-soup-ready'].key);
    expect(scene.displayObjects.length).toBe(initialCount);
    expect(scene.generated).toHaveLength(1);
    s.slots.burner_a = null;
    s.seats.human.held_item_id = 'pot';
    s.seats.human.position = { x: 250, y: 200 };
    send(); scene.update(16);
    expect(sprite).toMatchObject({ x: 272, y: 196, active: true });
    expect(sprite.depth).toBeGreaterThan(21);
    // An individual texture failure falls back safely without making another image.
    scene.textureKeys.delete(KITCHEN_ART['pot-soup-ready'].key);
    send();
    expect(sprite.visible).toBe(false);
    expect(scene.displayObjects.length).toBe(initialCount);
    s.seats.human.held_item_id = null;
    send();
    expect(sprite.active).toBe(false);
    expect(scene.displayObjects.filter(object => object.active && object.depth === 26)).toHaveLength(0);
  });
});

describe('confirmed kitchen animation', () => {
  function fixture() {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    harness.artwork = [ARTWORK.characters.key, ...Object.values(KITCHEN_ART).map(art => art.key)];
    const { game, scene } = mount();
    const s = observe(createGame(1000), 'human').snapshot;
    s.phase = 'playing';
    for (const key of Object.keys(s.slots) as Array<keyof typeof s.slots>) s.slots[key] = null;
    s.items = { food: { id: 'food', kind: 'ingredient', ingredient: 'cucumber', preparation: 'raw', chop_remaining_ms: 1500 } };
    s.slots.counter_left = 'food';
    s.seats.human.position = { x: 250, y: 350 };
    game.setActionsEnabled(true);
    const send = (at: number) => { now = at; s.server_time_ms += 50; s.state_version++; game.setSnapshot(structuredClone(s)); };
    const frame = (at: number) => { now = at; scene.update(at); };
    send(0); frame(0);
    const food = scene.displayObjects.find(o => o.textureKey === KITCHEN_ART['cucumber-raw'].key)!;
    return { game, scene, s, send, frame, food };
  }

  it('alternates the two foot regions while retaining a complete static character at rest', () => {
    const { scene, s, send, frame } = fixture();
    s.seats.human.active_action = { type: 'move_to', action_id: 'walk', target: { x: 350, y: 350 }, path: [{ x: 350, y: 350 }] };
    send(10); frame(90);
    const left = scene.displayObjects.find(o => o.frame === 'human-step-left')!;
    const right = scene.displayObjects.find(o => o.frame === 'human-step-right')!;
    expect(left, 'walking needs an independently moving left foot').toBeDefined();
    expect(right, 'walking needs an independently moving right foot').toBeDefined();
    expect(left.visible && right.visible).toBe(true);
    const firstDifference = left.y - right.y;
    frame(270);
    expect(firstDifference * (left.y - right.y)).toBeLessThan(0);
    s.seats.human.active_action = null;
    send(280); frame(280);
    expect(left.visible || right.visible).toBe(false);
    expect(scene.displayObjects.find(o => o.frame === 'human')?.visible).toBe(true);
  });

  it.each([
    { seat: 'human', direction: 'left', targetX: 180, flipX: false, originX: 0.39, heldX: 228, starX: 230 },
    { seat: 'human', direction: 'right', targetX: 320, flipX: true, originX: 0.61, heldX: 272, starX: 270 },
    { seat: 'ai', direction: 'left', targetX: 180, flipX: true, originX: 0.44, heldX: 228, starX: 230 },
    { seat: 'ai', direction: 'right', targetX: 320, flipX: false, originX: 0.56, heldX: 272, starX: 270 },
  ] as const)('faces $seat $direction consistently when walking and stopping without reversing the held side', ({ seat, targetX, flipX, originX, heldX, starX }) => {
    const { scene, s, send, frame, food } = fixture();
    s.seats[seat].position = { x: 250, y: 350 };
    s.seats[seat].active_action = { type: 'move_to', action_id: 'walk', target: { x: targetX, y: 350 }, path: [{ x: targetX, y: 350 }] };
    send(10); frame(90);
    const whole = scene.displayObjects.find(o => o.frame === seat)!;
    const parts = scene.displayObjects.filter(o => o.frame?.startsWith(`${seat}-`));
    expect(parts).toHaveLength(5);
    for (const part of parts) expect(part).toMatchObject({ visible: true, flipX });
    expect(whole.flipX).toBe(flipX);
    expect(whole.originX).toBeCloseTo(originX);
    expect(parts.find(o => o.frame === `${seat}-body`)!.originX).toBeCloseTo(originX);
    // The cropped shoes share the full image's foot anchor, even after mirroring.
    const leftOrigin = seat === 'human' ? (286.26 - 153) / 123 : (418.88 - 235) / 178;
    const rightOrigin = seat === 'human' ? (286.26 - 276) / 134 : (418.88 - 413) / 187;
    expect(parts.find(o => o.frame === `${seat}-step-left`)!.originX).toBeCloseTo(flipX ? 1 - leftOrigin : leftOrigin);
    expect(parts.find(o => o.frame === `${seat}-step-right`)!.originX).toBeCloseTo(flipX ? 1 - rightOrigin : rightOrigin);
    s.slots.counter_left = null; s.seats[seat].held_item_id = 'food'; send(100); frame(300);
    expect(food.x).toBe(heldX);
    expect(scene.displayObjects.find(o => o.kind === 'star')?.x).toBe(starX);
    s.seats[seat].active_action = null; send(310); frame(310);
    expect(whole).toMatchObject({ visible: true, flipX, x: 250, y: 368 });
    expect(whole.originX).toBeCloseTo(originX);
    expect(parts.every(part => !part.visible && part.flipX === flipX)).toBe(true);
    expect(food).toMatchObject({ x: heldX, y: 346 });
  });

  it('moves the same confirmed item on one short arc without restarting on repeated snapshots', () => {
    const { game, scene, s, send, frame, food } = fixture();
    s.slots.counter_left = null; s.seats.human.held_item_id = 'food';
    send(100); frame(100);
    expect(food).toMatchObject({ x: 274, y: 425 });
    frame(200);
    expect(food.x).toBeGreaterThan(272); expect(food.x).toBeLessThan(274);
    expect(food.y).toBeLessThan((425 + 346) / 2);
    game.setSnapshot(structuredClone(s));
    send(240); frame(300);
    expect(food).toMatchObject({ x: 272, y: 346 });
    expect(scene.displayObjects.filter(o => o.textureKey === KITCHEN_ART['cucumber-raw'].key)).toEqual([food]);
  });

  it.each([
    { kind: 'pumpkin', source: { x: 96, y: 185 } },
    { kind: 'cucumber', source: { x: 96, y: 255 } },
    { kind: 'cream', source: { x: 96, y: 325 } },
    { kind: 'plate', source: { x: 354, y: 425 } },
  ] as const)('animates a newly confirmed $kind from its stock without duplicating the item', ({ kind, source }) => {
    const { game, scene, s, send, frame } = fixture();
    const before = new Set(scene.displayObjects);
    s.items.stock = kind === 'plate' ? { id: 'stock', kind: 'plate', contents: [], recipe_id: null } :
      { id: 'stock', kind: 'ingredient', ingredient: kind, preparation: 'raw', chop_remaining_ms: kind === 'cream' ? 0 : 1500 };
    s.seats.human.held_item_id = 'stock';
    send(100); frame(100);
    const images = scene.displayObjects.filter(o => !before.has(o) && o.kind === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject(source);
    send(200); frame(300);
    expect(images[0]).toMatchObject({ x: 272, y: 346 });
    // Reconnecting with this already-held item must not replay its source animation.
    game.setActionsEnabled(false); game.setActionsEnabled(true); send(310); frame(310);
    expect(images[0]).toMatchObject({ x: 272, y: 346 });
  });

  it('retargets an interrupted pickup from its displayed position and ignores older ownership', () => {
    const { game, s, send, frame, food } = fixture();
    s.slots.counter_left = null; s.seats.human.held_item_id = 'food';
    send(100); frame(180);
    const old = structuredClone(s), displayed = { x: food.x, y: food.y };
    s.seats.human.held_item_id = null; s.slots.counter_right = 'food';
    send(180); frame(180);
    expect(food).toMatchObject(displayed);
    game.setSnapshot(old);
    frame(380);
    expect(food).toMatchObject({ x: 454, y: 425 });
  });

  it.each(['round', 'generation', 'finished', 'gap', 'disconnect', 'reduced'] as const)('snaps a pending transfer on %s instead of replaying it later', boundary => {
    let changeMotion: ((event: { matches: boolean }) => void) | undefined;
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false,
      addEventListener: (_: string, callback: typeof changeMotion) => { changeMotion = callback; }, removeEventListener() {} }) });
    const { game, s, send, frame, food } = fixture();
    s.slots.counter_left = null; s.seats.human.held_item_id = 'food';
    send(100); frame(140);
    expect(food.y).toBeGreaterThan(346);
    if (boundary === 'round') { s.round_id++; send(150); }
    if (boundary === 'generation') { s.seats.human.generation++; send(150); }
    if (boundary === 'finished') { s.phase = 'finished'; send(150); }
    if (boundary === 'gap') frame(1701);
    if (boundary === 'disconnect') game.setActionsEnabled(false);
    if (boundary === 'reduced') changeMotion!({ matches: true });
    frame(boundary === 'gap' ? 1701 : 150);
    expect(food).toMatchObject({ x: 272, y: 346 });
    if (boundary === 'disconnect') game.setActionsEnabled(true);
    if (boundary === 'reduced') changeMotion!({ matches: false });
    send(1800); frame(1800);
    expect(food).toMatchObject({ x: 272, y: 346 });
  });

  it('shows initial held items immediately and follows the facing side without a new transfer', () => {
    const { game, s, send, frame, food } = fixture();
    game.setActionsEnabled(false);
    s.slots.counter_left = null; s.seats.human.held_item_id = 'food';
    s.seats.human.active_action = { type: 'move_to', action_id: 'left', target: { x: 180, y: 350 }, path: [{ x: 180, y: 350 }] };
    game.setActionsEnabled(true); send(100); frame(100);
    expect(food.x).toBe(228);
    s.seats.human.active_action = null; send(150); frame(150);
    expect(food).toMatchObject({ x: 228, y: 346 });
  });

  it('places pickup feedback beside the left hand after the character turns left', () => {
    const { scene, s, send, frame, food } = fixture();
    s.seats.human.active_action = { type: 'move_to', action_id: 'left', target: { x: 180, y: 350 }, path: [{ x: 180, y: 350 }] };
    send(50); frame(50);
    s.seats.human.active_action = null;
    s.slots.counter_left = null; s.seats.human.held_item_id = 'food';
    send(100); frame(300);
    expect(food.x).toBe(228);
    expect(scene.displayObjects.find(o => o.kind === 'star')).toMatchObject({ x: 230, y: 316 });
  });

  it('moves the knife only for a fresh active chop and rests on pause or missing food', () => {
    const { scene, s, send, frame, food } = fixture();
    s.slots.counter_left = null; s.slots.chop = 'food'; send(20); frame(220);
    const knife = scene.displayObjects.find(o => o.textureKey === KITCHEN_ART.knife.key)!;
    expect(knife, 'the board needs its resting utensil').toBeDefined();
    const rest = { x: knife.x, y: knife.y, rotation: knife.rotation };
    expect(knife.displayWidth).toBeLessThanOrEqual(30);
    expect(knife.y).toBeLessThan(food.y - 6);
    s.seats.human.active_action = { type: 'chop', action_id: 'cut', target: 'chop', item_id: 'food' };
    send(230); frame(270);
    expect(knife.rotation).not.toBe(rest.rotation);
    s.seats.human.active_action = null; send(280); frame(280);
    expect(knife).toMatchObject(rest); expect(food.y).toBe(425);
    s.seats.human.active_action = { type: 'chop', action_id: 'cut', target: 'chop', item_id: 'missing' };
    send(300);
    expect(() => frame(320)).not.toThrow();
    expect(knife).toMatchObject(rest);
    s.seats.human.active_action.item_id = 'food'; send(350); frame(1851);
    expect(knife).toMatchObject(rest); expect(food.y).toBe(425);
  });

  it('releases the extra character regions and knife through repeated scene lifecycle exits', () => {
    const { scene } = fixture();
    const first = scene.displayObjects.filter(o => o.active);
    scene.events.emit('shutdown');
    expect(first.every(o => !o.active)).toBe(true);
    scene.create();
    const second = scene.displayObjects.filter(o => o.active);
    expect(second.filter(o => o.textureKey === ARTWORK.characters.key)).toHaveLength(12);
    expect(second.filter(o => o.textureKey === KITCHEN_ART.knife.key)).toHaveLength(1);
    scene.events.emit('destroy');
    expect(second.every(o => !o.active)).toBe(true);
  });
});
