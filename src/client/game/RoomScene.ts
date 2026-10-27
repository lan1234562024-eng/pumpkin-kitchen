import Phaser from 'phaser';
import { artUrl, watchArtLoading, type ArtLoadState } from './art-loading';
import type { GameSnapshot, Point, SeatId, StationId, SemanticAction, KitchenItem, IngredientItem } from '../../shared/contracts';
import { WORLD, STATION_IDS, KITCHEN_RULES } from '../../game/world';
import { KITCHEN_LAYOUT } from '../../game/kitchen-layout';
import { approachFor } from '../../game/navigation';
import { ARTWORK, ASSETS, KITCHEN_ART, SCENE_HEADROOM, STATION_ART_POINTS, itemArtwork, type KitchenArtId } from './assets';
import { SNAPSHOT_FRESH_MS, SnapshotFeedbackTracker, type SnapshotFeedback } from './snapshot-feedback';
import { createPresentationMotion } from './presentation-motion';
type MoveHandler = (point: Point) => void;
type Effect = Phaser.GameObjects.Star | Phaser.GameObjects.Text | Phaser.GameObjects.Ellipse;
type ItemView = {
    sprite?: Phaser.GameObjects.Image; graphics: Phaser.GameObjects.Graphics;
    owner: SeatId | StationId; displayed: Point;
    travel?: { from: Point; startedAt: number };
};
type CharacterPart = { sprite: Phaser.GameObjects.Image; originX: number; originY: number; step: number };
type SeatView = {
    sprite?: Phaser.GameObjects.Image;
    parts: CharacterPart[];
    fallback: Phaser.GameObjects.Arc;
    shadow: Phaser.GameObjects.Ellipse;
    label: Phaser.GameObjects.Text;
    facingLeft: boolean;
};
// Segment boundaries follow the actual station centers, not equal tiles.
const FURNITURE_ART: Array<{ id: KitchenArtId; x: number; y: number; width: number; height: number; depth?: number }> = [
    { id: 'table-small-square', x: 40, y: 50, width: 112, height: 100 },
    { id: 'table-small-square', x: 648, y: 50, width: 112, height: 100 },
    { id: 'cabinet-supply-vertical', x: 40, y: 145, width: 112, height: 250 },
    { id: 'cabinet-cooking-vertical', x: 648, y: 145, width: 112, height: 250 },
    { id: 'corner-left-empty', x: 40, y: 375, width: 112, height: 105 },
    { id: 'corner-right-empty', x: 648, y: 375, width: 112, height: 105 },
    { id: 'counter-prep-horizontal', x: 152, y: 400, width: 162, height: 80 },
    { id: 'table-small-square', x: 314, y: 400, width: 80, height: 80 },
    { id: 'counter-prep-horizontal', x: 394, y: 400, width: 170, height: 80 },
    { id: 'table-small-square', x: 564, y: 400, width: 84, height: 80 },
    // The face projects below the footprint; foot depth handles the lower approach.
    { id: 'island-two-slot-empty', x: 350, y: 140, width: 100, height: 184, depth: 20.3 },
];

/** Presentation follows confirmed snapshots; animated poses never advance game state. */
class RoomPhaserScene extends Phaser.Scene {
    private snapshot?: GameSnapshot;
    private tracker = new SnapshotFeedbackTracker();
    private lastSnapshotAt = -Infinity;
    private motion = { human: createPresentationMotion(), ai: createPresentationMotion() };
    private presentationFresh = false;
    private connected = false;
    private reducedMotion = false;
    private preference?: MediaQueryList;
    private seats: Partial<Record<SeatId, SeatView>> = {};
    private objects = new Map<string, ItemView>();
    private fixedArtwork: Phaser.GameObjects.Image[] = [];
    private foregroundMask?: Phaser.Display.Masks.GeometryMask;
    private foregroundShape?: Phaser.GameObjects.Graphics;
    private effects = new Map<Effect, Phaser.Time.TimerEvent>();
    private steam?: Phaser.GameObjects.Graphics;
    private knife?: Phaser.GameObjects.Image;
    private counterLayer?: Phaser.GameObjects.Image;
    private counterTextureKey?: string;
    private motionChanged = (event: MediaQueryListEvent) => { this.reducedMotion = event.matches; this.clearEffects(); this.clearItemTravel(); };
    constructor(private move: MoveHandler, private onArtLoad?: (state: ArtLoadState) => void) { super({ key: 'room' }); }
    preload() {
        const assetUrl = (url: string) => artUrl(url, import.meta.env.BASE_URL, import.meta.env.MODE, import.meta.env.PROD);
        const dispose = watchArtLoading(this.load, state => this.onArtLoad?.(state));
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, dispose);
        this.events.once(Phaser.Scenes.Events.DESTROY, dispose);
        this.load.image(ARTWORK.kitchen.key, assetUrl(ARTWORK.kitchen.url));
        this.load.image(ARTWORK.characters.key, assetUrl(ARTWORK.characters.url));
        for (const art of Object.values(KITCHEN_ART)) this.load.image(art.key, assetUrl(art.url));
    }
    create() {
        if (typeof window.matchMedia === 'function') {
            this.preference = window.matchMedia('(prefers-reduced-motion: reduce)');
            this.reducedMotion = this.preference.matches;
            this.preference.addEventListener('change', this.motionChanged);
        }
        this.cameras.main.setBackgroundColor('#f5ebd7');
        this.cameras.main.setScroll(0, -SCENE_HEADROOM);
        for (const art of Object.values(KITCHEN_ART)) {
            if (!this.textures.exists(art.key)) continue;
            const texture = this.textures.get(art.key), f = art.frame;
            if (!texture.has('visible')) texture.add('visible', 0, f.x, f.y, f.width, f.height);
        }
        this.floor();
        this.counters();
        this.foregroundWalls();
        this.createSeats();
        const knife = KITCHEN_ART.knife;
        if (this.textures.exists(knife.key)) this.knife = this.add.image(0, 0, knife.key, 'visible')
            .setDisplaySize(28, 28 * knife.frame.height / knife.frame.width).setOrigin(0.82, 0.5).setDepth(24);
        this.restKnife();
        this.steam = this.add.graphics().setDepth(24);
        this.input.on('pointerdown', this.pointer, this);
        const cleanup = () => { this.events.off(Phaser.Scenes.Events.SHUTDOWN, cleanup); this.events.off(Phaser.Scenes.Events.DESTROY, cleanup); this.preference?.removeEventListener('change', this.motionChanged); this.input.off('pointerdown', this.pointer, this); this.clearEffects(); this.tracker.reset(); for (const view of this.objects.values())
            this.destroyItem(view); this.objects.clear(); this.knife?.destroy(); this.knife = undefined; for (const view of Object.values(this.seats)) { view.sprite?.destroy(); for (const part of view.parts) part.sprite.destroy(); view.fallback.destroy(); view.shadow.destroy(); view.label.destroy(); } this.steam?.destroy(); this.steam = undefined; for (const image of this.fixedArtwork) image.destroy(); this.fixedArtwork = []; this.foregroundMask?.destroy(); this.foregroundMask = undefined; this.foregroundShape?.destroy(); this.foregroundShape = undefined; this.counterLayer?.destroy(); this.counterLayer = undefined; if (this.counterTextureKey) this.textures.remove(this.counterTextureKey); this.counterTextureKey = undefined; this.seats = {}; this.snapshot = undefined; this.lastSnapshotAt = -Infinity; this.resetMotion(); this.connected = false; };
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, cleanup);
        this.events.once(Phaser.Scenes.Events.DESTROY, cleanup);
        this.draw();
    }
    private pointer(pointer: Phaser.Input.Pointer) { const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y); this.move({ x: Math.round(point.x), y: Math.round(point.y) }); }
    private clearItemTravel() { for (const view of this.objects.values()) view.travel = undefined; }
    private resetMotion() { this.motion.human.reset(); this.motion.ai.reset(); this.presentationFresh = false; this.clearItemTravel(); this.restKnife(); }
    setSnapshot(s: GameSnapshot) { const now = performance.now(), result = this.tracker.observe(s, now); if (!result.accepted)
        return; const previous = this.snapshot; if (result.reset || now - this.lastSnapshotAt > SNAPSHOT_FRESH_MS)
        this.resetMotion(); for (const id of ['human', 'ai'] as const)
        this.motion[id].observe({ serverTime: s.server_time_ms, position: s.seats[id].position, roundId: s.round_id, generation: s.seats[id].generation }, now); if (result.reset || !previous || s.server_time_ms !== previous.server_time_ms || s.state_version !== previous.state_version)
        this.lastSnapshotAt = now; if (result.reset)
        this.clearEffects(); this.snapshot = s; this.draw(now, !result.reset && this.connected && !this.reducedMotion && s.phase === 'playing', previous); if (this.connected && this.steam)
        for (const effect of result.effects)
            this.feedback(effect); }
    setActionsEnabled(enabled: boolean) { this.connected = enabled; if (!enabled) {
        this.tracker.reset();
        this.lastSnapshotAt = -Infinity;
        this.resetMotion();
        this.clearEffects();
    } }
    private floor() {
        const a = ARTWORK.kitchen;
        if (this.textures.exists(a.key)) {
            this.add.image(0, -SCENE_HEADROOM, a.key).setOrigin(0).setDisplaySize(WORLD.width, WORLD.height + SCENE_HEADROOM);
        }
        else
            this.add.grid(400, (500-SCENE_HEADROOM)/2, 800, 500+SCENE_HEADROOM, 40, 40, 0xf8efd9, 1, 0xd9c7a9, 0.4);
    }
    private foregroundWalls() {
        const a = ARTWORK.kitchen;
        if (!this.textures.exists(a.key)) return;
        // Trace only the terminal stones. A rectangular crop would paint floor over cabinets.
        const left = [{x:0,y:423},{x:23,y:423},{x:27,y:427},{x:34,y:424},{x:51,y:425},
            {x:58,y:431},{x:61,y:445},{x:64,y:477},{x:64,y:500},{x:0,y:500}];
        this.foregroundShape = this.add.graphics().setVisible(false);
        this.foregroundShape.fillStyle(0xffffff).fillPoints(left, true).fillPoints(left.map(p=>({x:800-p.x,y:p.y})), true);
        this.foregroundMask = this.foregroundShape.createGeometryMask();
        this.fixedArtwork.push(this.add.image(0, -SCENE_HEADROOM, a.key).setOrigin(0)
            .setDisplaySize(WORLD.width, WORLD.height + SCENE_HEADROOM).setDepth(29).setMask(this.foregroundMask));
    }
    private fixedImage(id: KitchenArtId, x: number, y: number, width: number, maxHeight: number, depth = 11, originX = 0.5, originY = 0.6, flipX = false): boolean {
        const art = KITCHEN_ART[id];
        if (!this.textures.exists(art.key)) return false;
        const scale = Math.min(width / art.frame.width, maxHeight / art.frame.height);
        this.fixedArtwork.push(this.add.image(x, y, art.key, 'visible').setOrigin(originX, originY).setDisplaySize(art.frame.width * scale, art.frame.height * scale).setDepth(depth).setFlipX(flipX));
        return true;
    }
    private stationPoint(id: typeof STATION_IDS[number]): Point {
        const p = STATION_ART_POINTS[id];
        // Pots rest on the raised stove grate, above the stove body's center.
        return id.startsWith('burner_') ? {x:p.x,y:p.y-8} : p;
    }
    private counters() {
        const g = this.add.graphics();
        for (const r of FURNITURE_ART) {
            const art = KITCHEN_ART[r.id];
            if (this.textures.exists(art.key)) {
                this.fixedArtwork.push(this.add.image(r.x, r.y, art.key, 'visible').setOrigin(0).setDisplaySize(r.width, r.height).setDepth(r.depth ?? 9));
                continue;
            }
            g.fillStyle(0x9a734d).fillRoundedRect(r.x, r.y + 7, r.width, r.height - 7, 13);
            g.fillStyle(0xf4d6a6).lineStyle(2, 0xb48a5b).fillRoundedRect(r.x, r.y, r.width, r.height - 12, 13).strokeRoundedRect(r.x, r.y, r.width, r.height - 12, 13);
            g.fillStyle(0xffedce, 0.75).fillRoundedRect(r.x + 6, r.y + 6, r.width - 12, r.height - 27, 9);
        }
        for (const id of STATION_IDS) {
            const p = STATION_ART_POINTS[id];
            const fixed = id === 'source_pumpkin' ? 'basket-pumpkin' : id === 'source_cucumber' ? 'basket-cucumber' : id === 'source_cream' ? 'cream-carton' : id === 'chop' ? 'cutting-board-empty' : id === 'plates' ? 'bowl-stack' : undefined;
            if (fixed && this.fixedImage(fixed, p.x, p.y, id === 'chop' ? 64 : id === 'source_cream' ? 28 : id === 'plates' ? 44 : 58, id === 'chop' ? 34 : id === 'plates' ? 45 : 56)) continue;
            if (id === 'orders' && this.fixedImage('prop-order-clipboard', p.x, p.y, 46, 54, 11, 0.5, 0.5)) continue;
            if (id === 'delivery' && this.fixedImage('prop-serving-tray-bell', p.x, p.y, 78, 46, 11, 0.5, 0.5)) continue;
            if (id.startsWith('burner_') && this.fixedImage('prop-stove-empty', p.x, p.y, 64, 57, 11, 0.5, 0.5)) continue;
            if (id === 'cleanup' && this.fixedImage('prop-cleanup-bin', p.x, p.y, 48, 36)) continue;
            if (id === 'counter_left' || id === 'counter_right') continue;
            if (id.startsWith('handoff') && this.textures.exists(KITCHEN_ART['island-two-slot-empty'].key)) continue;
            g.save();
            g.translateCanvas(p.x, p.y);
            if (id.startsWith('source_')) {
                g.fillStyle(0xb98955).lineStyle(2, 0x89613d).fillRoundedRect(-33, -29, 66, 58, 6).strokeRoundedRect(-33, -29, 66, 58, 6);
                g.lineStyle(2, 0xd9b582).lineBetween(-29, -16, 29, -16).lineBetween(-29, 16, 29, 16);
                this.ingredient(g, { id: 'stock', kind: 'ingredient', ingredient: id.slice(7) as IngredientItem['ingredient'], preparation: 'raw', chop_remaining_ms: 0 }, 0, 0, 0.85);
            }
            else if (id === 'chop') {
                g.fillStyle(0xc5935c).lineStyle(2, 0x936435).fillRoundedRect(-29, -22, 58, 44, 6).strokeRoundedRect(-29, -22, 58, 44, 6);
                g.fillStyle(0xe0e9e5).fillRoundedRect(6, -18, 9, 25, 2);
                g.fillStyle(0x735746).fillRoundedRect(6, 6, 9, 12, 2);
            }
            else if (id.startsWith('burner_')) {
                g.fillStyle(0x656468).fillRoundedRect(-33, -30, 66, 60, 8);
                g.lineStyle(3, 0xa8a5a0).strokeCircle(0, -2, 22);
                g.fillStyle(0xe5bd77).fillCircle(-20, 23, 4).fillCircle(20, 23, 4);
            }
            else if (id === 'plates') {
                for (let i = 2; i >= 0; i--) {
                    g.fillStyle(0xfffdf4).lineStyle(2, 0xbfc3bc).fillEllipse(0, i * 5 - 3, 46, 27).strokeEllipse(0, i * 5 - 3, 46, 27);
                }
            }
            else if (id === 'orders') {
                g.fillStyle(0xb98c5f).fillRoundedRect(-25, -30, 50, 60, 5);
                g.fillStyle(0xfffcdf).fillRect(-20, -24, 40, 48);
                g.fillStyle(0x8a8d7b).fillRoundedRect(-9, -34, 18, 9, 3);
                g.lineStyle(3, 0xbca783);
                for (let y = -13; y < 20; y += 11)
                    g.lineBetween(-12, y, 12, y);
            }
            else if (id === 'delivery') {
                g.fillStyle(0xfff9e3).lineStyle(2, 0xb9a37b).fillEllipse(0, 10, 60, 30).strokeEllipse(0, 10, 60, 30);
                g.fillStyle(0xd0b075).fillCircle(0, -1, 22);
                g.fillStyle(0xf6daa1).fillEllipse(0, 1, 44, 25);
                g.fillStyle(0x9a7945).fillCircle(0, -23, 4);
            }
            else if (id === 'cleanup') {
                g.fillStyle(0xa1aaa0).lineStyle(2, 0x758376).fillRoundedRect(-21, -22, 42, 43, 5).strokeRoundedRect(-21, -22, 42, 43, 5);
                g.lineStyle(4, 0xe1e5d8).lineBetween(-12, -10, 12, 11).lineBetween(-12, 11, 12, -10);
            }
            else {
                g.fillStyle(id.startsWith('handoff') ? 0xe8b6ac : 0xdabc94, 0.75).lineStyle(2, 0xbb947a, 0.6).fillRoundedRect(-29, -25, 58, 50, 7).strokeRoundedRect(-29, -25, 58, 50, 7);
            }
            g.restore();
        }
        // Floor vases sit behind the upper tables; their bases are hidden by the cabinets.
        this.fixedImage('decor-flowers', 96, 68, 78, 92, 8, 0.5, 1);
        this.fixedImage('decor-flowers', 704, 68, 78, 92, 8, 0.5, 1, true);
        // Flat corner accents leave the ingredient and burner worktops unobstructed.
        this.fixedImage('decor-mat-cat', 94, 420, 84, 40, 11, 0.5, 0.5);
        this.fixedImage('decor-mat-star', 706, 420, 84, 40, 11, 0.5, 0.5);
        // Only the outer cabinet feet meet these foreground leaves.
        this.fixedImage('foliage-front-left', 0, 500, 65, 50, 30, 0, 1);
        this.fixedImage('foliage-front-right', 800, 500, 65, 50, 30, 1, 1);
        // Missing art uses one baked fallback, never per-frame vector replay.
        this.counterTextureKey = `room-counters-${Phaser.Utils.String.UUID()}`;
        try {
            g.generateTexture(this.counterTextureKey, WORLD.width, WORLD.height);
            this.counterLayer = this.add.image(0, 0, this.counterTextureKey).setOrigin(0).setDisplaySize(WORLD.width, WORLD.height).setDepth(10);
        } finally {
            g.destroy();
        }
    }
    private createSeats() { const a = ARTWORK.characters, has = this.textures.exists(a.key); for (const id of ['human', 'ai'] as const) {
        const f = a.frames[id];
        const parts: CharacterPart[] = [];
        if (has) {
            const texture = this.textures.get(a.key);
            if (!texture.has(id)) texture.add(id, 0, f.x, f.y, f.width, f.height);
            // Only the shoes/lower shins move. Side strips retain the entire tail and hair.
            // The upper region overlaps the shins by ~1px at display scale, hiding the seam.
            const cut = id === 'human' ? { y: 766, left: 153, middle: 276, right: 410 } : { y: 909, left: 235, middle: 413, right: 600 };
            const regions = [
                { name: 'body', x: 0, y: 0, width: f.width, height: cut.y + 12, step: 0 },
                { name: 'edge-left', x: 0, y: cut.y, width: cut.left, height: f.height - cut.y, step: 0 },
                { name: 'edge-right', x: cut.right, y: cut.y, width: f.width - cut.right, height: f.height - cut.y, step: 0 },
                { name: 'step-left', x: cut.left, y: cut.y, width: cut.middle - cut.left, height: f.height - cut.y, step: 1 },
                { name: 'step-right', x: cut.middle, y: cut.y, width: cut.right - cut.middle, height: f.height - cut.y, step: -1 },
            ];
            for (const r of regions) {
                const key = `${id}-${r.name}`;
                if (!texture.has(key)) texture.add(key, 0, f.x + r.x, f.y + r.y, r.width, r.height);
                parts.push({ sprite: this.add.image(0, 0, a.key, key).setVisible(false),
                    originX: (f.width * f.originX - r.x) / r.width, originY: (f.height - r.y) / r.height, step: r.step });
            }
        }
        this.seats[id] = { sprite: has ? this.add.image(0, 0, a.key, id).setOrigin(f.originX, 1).setDisplaySize(f.displayHeight * f.width / f.height, f.displayHeight) : undefined, parts, fallback: this.add.circle(0, 0, 18, ASSETS.seats[id].color).setVisible(!has), shadow: this.add.ellipse(0, 0, 38, 12, 0x4b3822, 0.22).setDepth(12), label: this.add.text(0, 0, id === 'human' ? '玩家' : '队友', { fontFamily: 'system-ui', fontSize: '11px', color: '#6f5543', backgroundColor: '#fff7e8', padding: { x: 5, y: 2 } }).setOrigin(0.5, 0).setDepth(101), facingLeft: false };
    } }
    private ingredient(g: Phaser.GameObjects.Graphics, item: IngredientItem, x: number, y: number, scale = 1) {
        g.save();
        g.translateCanvas(x, y);
        g.scaleCanvas(scale, scale);
        const chopped = item.preparation !== 'raw';
        if (item.ingredient === 'pumpkin') {
            g.fillStyle(item.preparation === 'cooked' ? 0xf6bd54 : 0xe99035).lineStyle(1.5, 0xb57231);
            if (chopped) {
                for (const [dx, dy] of [[-8, -5], [9, 1], [-6, 10]])
                    g.fillRoundedRect(dx - 7, dy - 6, 14, 12, 3).strokeRoundedRect(dx - 7, dy - 6, 14, 12, 3);
            }
            else {
                g.fillEllipse(0, 0, 35, 29).strokeEllipse(0, 0, 35, 29);
                g.lineStyle(1.5, 0xf9bb59).strokeEllipse(0, 0, 17, 27);
                g.fillStyle(0x6b8751).fillRoundedRect(-3, -21, 6, 9, 2);
            }
        }
        else if (item.ingredient === 'cucumber') {
            g.fillStyle(0x609758).lineStyle(2, 0x426b43);
            if (chopped) {
                for (const dx of [-12, 0, 12]) {
                    g.fillStyle(0x5b8c50).fillCircle(dx, 0, 8);
                    g.fillStyle(0xd9e6a6).fillCircle(dx, 0, 5);
                }
            }
            else
                g.fillRoundedRect(-9, -23, 18, 46, 8).strokeRoundedRect(-9, -23, 18, 46, 8);
        }
        else {
            g.fillStyle(0xfffcdf).lineStyle(2, 0xb0c8bc).fillRoundedRect(-12, -18, 24, 36, 3).strokeRoundedRect(-12, -18, 24, 36, 3);
            g.fillStyle(0xa8c5b0).fillRect(-10, -12, 20, 9);
            g.fillStyle(0xffeeb0).fillCircle(0, 7, 6);
        }
        g.restore();
    }
    private item(g: Phaser.GameObjects.Graphics, item: KitchenItem) {
        if (item.kind === 'ingredient') {
            this.ingredient(g, item, 0, 0);
            return;
        }
        g.fillStyle(item.kind === 'pot' ? 0x757b78 : 0xfffcf2).lineStyle(2, item.kind === 'pot' ? 0x515b59 : 0xaab9b2).fillEllipse(0, 0, item.kind === 'pot' ? 50 : 52, 34).strokeEllipse(0, 0, item.kind === 'pot' ? 50 : 52, 34);
        if (item.kind === 'pot') {
            g.fillStyle(0x555f5a).fillRoundedRect(-34, -4, 11, 8, 3).fillRoundedRect(23, -4, 11, 8, 3);
            g.fillStyle(item.phase.includes('soup') ? 0xf9b751 : 0xe9dfc7).fillEllipse(0, -2, 40, 23);
        }
        if (item.kind === 'plate' && item.recipe_id === 'pumpkin_soup')
            g.fillStyle(0xf9b751).fillEllipse(0, -2, 40, 23);
        for (const [index, id] of item.contents.entries()) {
            const food = this.snapshot?.items[id];
            if (food?.kind === 'ingredient')
                this.ingredient(g, food, index === 0 ? -6 : 8, -3, 0.45);
        }
    }
    private progress(g: Phaser.GameObjects.Graphics, item: KitchenItem) {
        if (item.kind === 'pot' && item.remaining_ms > 0) {
            const total = item.phase.includes('soup') ? KITCHEN_RULES.simmer_soup_ms : KITCHEN_RULES.cook_pumpkin_ms;
            g.fillStyle(0x584d3c).fillRoundedRect(-24, 24, 48, 5, 2);
            g.fillStyle(item.phase.startsWith('loaded') ? 0xe5b180 : 0x96bf83).fillRoundedRect(-24, 24, 48 * (1 - item.remaining_ms / total), 5, 2);
        }
    }
    private destroyItem(view: ItemView) { view.sprite?.destroy(); view.graphics.destroy(); }
    private positionItem(view: ItemView, x: number, y: number) { view.displayed = { x, y }; view.sprite?.setPosition(x, y); view.graphics.setPosition(x, y); }
    private itemPoint(view: ItemView, target: Point, now: number): Point {
        if (!view.travel) return target;
        const t = Math.max(0, Math.min(1, (now - view.travel.startedAt) / 200));
        if (t === 1) { view.travel = undefined; return target; }
        const ease = t * t * (3 - 2 * t), from = view.travel.from;
        return { x: from.x + (target.x - from.x) * ease,
            y: from.y + (target.y - from.y) * ease - Math.sin(Math.PI * t) * 9 };
    }
    private heldPoint(id: SeatId, point: Point, bob = 0): Point {
        return { x: point.x + (this.seats[id]?.facingLeft ? -22 : 22), y: point.y - 4 - bob };
    }
    private restKnife() { const p = this.stationPoint('chop'); this.knife?.setPosition(p.x + 17, p.y - 13).setRotation(-0.08).setDepth(24); }
    private draw(now = performance.now(), allowTravel = false, previous?: GameSnapshot) {
        if (!this.snapshot || !this.steam)
            return;
        const locations = new Map<string, { point: Point; owner: SeatId | StationId }>();
        for (const id of STATION_IDS) {
            const item = this.snapshot.slots[id];
            if (item)
                locations.set(item, { point: this.stationPoint(id), owner: id });
        }
        for (const id of ['human', 'ai'] as const) {
            const p = this.snapshot.seats[id];
            if (p.held_item_id)
                locations.set(p.held_item_id, { point: this.heldPoint(id, p.position), owner: id });
        }
        for (const [id, view] of this.objects)
            if (!locations.has(id)) {
                this.destroyItem(view);
                this.objects.delete(id);
            }
        for (const [id, location] of locations) {
            const p = location.point;
            const item = this.snapshot.items[id];
            if (!item) continue;
            let view = this.objects.get(id);
            if (!view) {
                view = { graphics: this.add.graphics().setDepth(26), owner: location.owner, displayed: { ...p } };
                // Stock creates an item directly in the confirmed hand. Only a fresh,
                // newly-created item has a known source; initial/reconnected state snaps.
                if (allowTravel && previous && !previous.items[id] && (location.owner === 'human' || location.owner === 'ai')) {
                    const source = item.kind === 'ingredient' && item.preparation === 'raw' ? `source_${item.ingredient}` as StationId :
                        item.kind === 'plate' && item.contents.length === 0 && !item.recipe_id ? 'plates' : undefined;
                    if (source) view.travel = { from: this.stationPoint(source), startedAt: now };
                }
                this.objects.set(id, view);
            }
            if (view.owner !== location.owner) {
                view.travel = allowTravel ? { from: { ...view.displayed }, startedAt: now } : undefined;
                view.owner = location.owner;
            }
            const selected = itemArtwork(item, this.snapshot.items), art = selected ? KITCHEN_ART[selected] : undefined;
            view.graphics.clear();
            if (art && this.textures.exists(art.key)) {
                if (!view.sprite) view.sprite = this.add.image(p.x, p.y, art.key, 'visible').setDepth(25);
                view.sprite.setTexture(art.key, 'visible').setVisible(true);
                view.sprite.setOrigin(0.5, item.kind === 'ingredient' ? 0.5 : item.kind === 'pot' ? 0.85 : 0.78);
                const width = item.kind === 'pot' ? 54 : item.kind === 'plate' ? 38 : item.ingredient === 'cream' ? 22 : item.preparation === 'raw' ? 28 : 32;
                view.sprite.setDisplaySize(width, width * art.frame.height / art.frame.width);
            } else {
                view.sprite?.setVisible(false);
                this.item(view.graphics, item);
            }
            this.progress(view.graphics, item);
            const displayed = this.itemPoint(view, p, now);
            this.positionItem(view, displayed.x, displayed.y);
        }
    }
    update(time: number) {
        if (!this.snapshot || !this.steam)
            return;
        const now = performance.now(), fresh = this.connected && now - this.lastSnapshotAt <= SNAPSHOT_FRESH_MS, playing = fresh && this.snapshot.phase === 'playing', animate = fresh && !this.reducedMotion && this.snapshot.phase !== 'finished';
        if (!fresh && this.presentationFresh)
            this.resetMotion();
        this.presentationFresh = fresh;
        if (!animate) this.clearItemTravel();
        this.steam.clear();
        const heldPoints: Partial<Record<SeatId, Point>> = {};
        for (const id of ['human', 'ai'] as const) {
            const p = this.snapshot.seats[id], v = this.seats[id];
            if (!v)
                continue;
            const point = fresh && !this.reducedMotion ? this.motion[id].sample(now) ?? p.position : p.position;
            const f = ARTWORK.characters.frames[id], moving = playing && p.active_action?.type === 'move_to';
            if (moving && p.active_action?.type === 'move_to') {
                const dx = (p.active_action.path[0]?.x ?? p.active_action.target.x) - p.position.x;
                if (Math.abs(dx) > 0.5)
                    v.facingLeft = dx < 0;
            }
            const walking = animate && moving, stride = Math.sin(time * Math.PI / 180);
            const bob = walking ? Math.abs(stride) * 0.55 : 0, breath = animate && !moving ? Math.sin(time / 700) * 0.008 : 0, foot = point.y + ARTWORK.characters.feetOffsetY, scale = f.displayHeight / f.height;
            const flipX = v.facingLeft !== (f.nativeFacing === 'left');
            v.sprite?.setVisible(!walking).setPosition(point.x, foot).setOrigin(flipX ? 1 - f.originX : f.originX, 1).setFlipX(flipX).setScale(scale * (1 - breath / 3), scale * (1 + breath)).setRotation(0).setDepth(20 + foot / 1000);
            for (const part of v.parts) {
                const lift = part.step ? Math.max(0, stride * part.step) * 1.2 : bob;
                part.sprite.setVisible(walking).setOrigin(flipX ? 1 - part.originX : part.originX, part.originY)
                    .setFlipX(flipX).setScale(scale).setPosition(point.x + (part.step ? stride * part.step * 0.4 : 0), foot - lift)
                    .setRotation(part.step ? 0 : stride * 0.004).setDepth(20 + foot / 1000 + (part.step ? 0 : 0.0001));
            }
            v.fallback.setPosition(point.x, point.y - bob).setDepth(20 + foot / 1000);
            v.shadow.setPosition(point.x, foot - 2);
            v.label.setPosition(Phaser.Math.Clamp(point.x, 22, 778), Math.max(-SCENE_HEADROOM + 4, foot - f.displayHeight - 20));
            heldPoints[id] = this.heldPoint(id, point, bob);
            if (playing && p.active_action?.type === 'chop') {
                const item = this.snapshot.items[p.active_action.item_id];
                if (item?.kind === 'ingredient' && this.snapshot.slots.chop === item.id) {
                    const total = item.ingredient === 'pumpkin' ? 2000 : 1500, pos = this.stationPoint('chop');
                    this.steam.fillStyle(0x7a6650).fillRect(pos.x - 25, pos.y + 29, 50, 5).fillStyle(0x8ebd7f).fillRect(pos.x - 25, pos.y + 29, 50 * (1 - item.chop_remaining_ms / total), 5);
                }
            }
        }
        const chopId = this.snapshot.slots.chop, chopItem = chopId ? this.snapshot.items[chopId] : undefined;
        const chopping = playing && !this.reducedMotion && chopItem?.kind === 'ingredient' && chopItem.preparation === 'raw' && chopItem.chop_remaining_ms > 0 &&
            (['human', 'ai'] as const).some(id => { const action = this.snapshot!.seats[id].active_action; return action?.type === 'chop' && action.target === 'chop' && action.item_id === chopId; });
        // A short downstroke follows a slower lift; no tween survives a pause/reset.
        const cutPhase = (time % 360) / 360, lift = cutPhase < 0.7 ? Math.sin(cutPhase / 0.7 * Math.PI / 2) : (1 - cutPhase) / 0.3;
        const impact = chopping && cutPhase > 0.88 ? Math.sin((cutPhase - 0.88) / 0.12 * Math.PI) : 0;
        this.restKnife();
        if (chopping) {
            const p = this.stationPoint('chop');
            this.knife?.setPosition(p.x + 19, p.y - 2 - lift * 8).setRotation(0.08 + lift * 0.55).setDepth(27);
            if (impact > 0) for (const direction of [-1, 1]) this.steam.fillStyle(chopItem.ingredient === 'pumpkin' ? 0xe9a24e : 0x79a963, impact * 0.8)
                .fillCircle(p.x + direction * (10 + impact * 3), p.y - 2 - impact * 3, 1.2);
        }
        for (const view of this.objects.values()) {
            const target = view.owner === 'human' || view.owner === 'ai' ? heldPoints[view.owner]! : this.stationPoint(view.owner);
            const displayed = this.itemPoint(view, target, now);
            this.positionItem(view, displayed.x, displayed.y - (view.owner === 'chop' ? impact * 0.9 : 0));
        }
        for (const id of ['burner_a', 'burner_b'] as const) {
            const item = this.snapshot.items[this.snapshot.slots[id] ?? ''];
            if (!playing || item?.kind !== 'pot' || !item.phase.startsWith('cooking'))
                continue;
            const pos = this.stationPoint(id);
            for (let i = 0; i < (this.reducedMotion ? 1 : 3); i++) {
                const t = this.reducedMotion ? 0.35 : (time / 850 + i / 3) % 1;
                this.steam.fillStyle(0xffffff, 0.65 * (1 - t)).fillCircle(pos.x + (i - 1) * 10, pos.y - 20 - t * 22, 3 + t * 3);
            }
        }
    }
    private removeEffect(o: Effect) { this.effects.get(o)?.remove(false); this.effects.delete(o); this.tweens.killTweensOf(o); o.destroy(); }
    private clearEffects() { for (const o of [...this.effects.keys()])
        this.removeEffect(o); }
    private feedback(effect: SnapshotFeedback) { if (!this.snapshot)
        return; let object: Effect; const duration = this.reducedMotion ? 300 : 650; if (effect.type === 'item_taken') {
        const p = this.snapshot.seats[effect.seatId].position;
        object = this.add.star(p.x + (this.seats[effect.seatId]?.facingLeft ? -20 : 20), p.y - 34, 4, 3, 7, 0xffda75);
    }
    else if (effect.type === 'handoff') {
        const p = this.stationPoint(effect.target);
        object = this.add.ellipse(p.x, p.y, 62, 40, 0xf7b7d0, 0.5);
    }
    else {
        const p = this.stationPoint('delivery');
        object = this.add.text(p.x, p.y - 45, `+${effect.delta}`, { fontSize: '18px', color: '#86612c', stroke: '#fff5df', strokeThickness: 3 }).setOrigin(0.5);
    } while (this.effects.size >= 16)
        this.removeEffect(this.effects.keys().next().value!); object.setDepth(110); this.effects.set(object, this.time.delayedCall(duration, () => this.removeEffect(object))); if (!this.reducedMotion)
        this.tweens.add({ targets: object, y: object.y - 10, alpha: 0, duration }); }
}
export interface RoomGame {
    setSnapshot(snapshot: GameSnapshot): void;
    setControlSeat(seat: SeatId): void;
    setActionsEnabled(enabled: boolean): void;
    destroy(): void;
}
export function mountRoomGame(container: HTMLElement, onIntent: (action: SemanticAction, seat: SeatId) => void, onFrame?: (duration: number) => void, onArtLoad?: (state: ArtLoadState) => void): RoomGame {
    let snapshot: GameSnapshot | undefined, seat: SeatId = 'human', enabled = false, scene: RoomPhaserScene | undefined;
    let frameStartedAt: number | undefined;
    const beginFrame = () => { frameStartedAt = performance.now(); };
    const endFrame = () => { if (frameStartedAt !== undefined) onFrame?.(performance.now() - frameStartedAt); frameStartedAt = undefined; };
    const move = (point: Point) => {
        if (!enabled || snapshot?.phase !== 'playing' || snapshot.seats[seat].controller !== 'human')
            return;
        // The camera's character headroom is scenery, outside the playable world.
        if (point.x < 0 || point.x > WORLD.width || point.y < 0 || point.y > WORLD.height) return;
        const hits = (r: {x: number; y: number; width: number; height: number}) => point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
        const furniture = KITCHEN_LAYOUT.furniture.some(hits) || FURNITURE_ART.some(hits);
        let target = point;
        if (furniture) {
            const id = [...STATION_IDS].sort((a, b) => Phaser.Math.Distance.BetweenPoints(point, STATION_ART_POINTS[a]) - Phaser.Math.Distance.BetweenPoints(point, STATION_ART_POINTS[b]))[0];
            const approach = approachFor(snapshot.seats[seat].position, id);
            if (!approach)
                return;
            target = approach;
        }
        onIntent({ type: 'move_to', target }, seat);
    };
    const game = new Phaser.Game({ type: Phaser.AUTO, parent: container, width: 800, height: WORLD.height + SCENE_HEADROOM, backgroundColor: '#f7edda', scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: 800, height: WORLD.height + SCENE_HEADROOM }, render: { antialias: true, roundPixels: true }, loader: { timeout: 15000 }, scene: [new RoomPhaserScene(move, onArtLoad)], callbacks: { postBoot: instance => { instance.events.on(Phaser.Core.Events.PRE_STEP, beginFrame); instance.events.on(Phaser.Core.Events.POST_RENDER, endFrame); scene = instance.scene.getScene('room') as RoomPhaserScene; scene.setActionsEnabled(enabled); if (snapshot)
                scene.setSnapshot(snapshot); } } });
    return { setSnapshot(s) { snapshot = s; scene?.setSnapshot(s); }, setControlSeat(id) { seat = id; }, setActionsEnabled(value) { enabled = value; scene?.setActionsEnabled(value); }, destroy() { enabled = false; snapshot = undefined; scene = undefined; game.events.off(Phaser.Core.Events.PRE_STEP, beginFrame); game.events.off(Phaser.Core.Events.POST_RENDER, endFrame); game.destroy(true); container.replaceChildren(); } };
}

