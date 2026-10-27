import type { SeatId, KitchenItem } from '../../shared/contracts';
import type { TargetId } from '../../game/kitchen-layout';

// Leave space above the walkable world for taller character art; feet stay in WORLD.
export const SCENE_HEADROOM = 64;
/** Worktop centers, independent of the cabinet faces and authoritative approach points. */
export const STATION_ART_POINTS = {
  orders: {x:96,y:84}, delivery: {x:704,y:84},
  source_pumpkin: {x:96,y:185}, source_cucumber: {x:96,y:255}, source_cream: {x:96,y:325},
  burner_a: {x:704,y:198}, burner_b: {x:704,y:303},
  chop: {x:194,y:425}, counter_left: {x:274,y:425}, plates: {x:354,y:425},
  counter_right: {x:454,y:425}, cleanup: {x:604,y:425},
  handoff_a: {x:400,y:184}, handoff_b: {x:400,y:254},
} as const satisfies Record<TargetId,{x:number;y:number}>;

/** Source frames and anchors affect rendering only; WORLD remains authoritative. */
export const ARTWORK = {
  kitchen: {
    key:'kitchen-bg-rect-v4',url:'/assets/art/kitchen-v4/background-courtyard-rect.png',
    width:1586,height:992,
  },
  characters: {
    key:'character-pair-v1',url:'/assets/art/character-pair-v1.png',
    frames: {
      human: {x:781,y:150,width:734,height:861,displayHeight:84,originX:0.39,nativeFacing:'left'},
      ai: {x:35,y:7,width:748,height:1008,displayHeight:94,originX:0.56,nativeFacing:'right'},
    } satisfies Record<SeatId,{x:number;y:number;width:number;height:number;displayHeight:number;originX:number;nativeFacing:'left'|'right'}>,
    // The logical seat position is its center. Art is anchored at the feet.
    feetOffsetY:18,
  },
  stations: {
    width:1448,height:1086,
    // Identical source framing keeps every counter body at the same scale.
    frame:{x:8,y:172,width:1432,height:724},
    origin:{x:0.5,y:1},bottomOffsetY:18,
    handoffItemOffsetY:-32,fallbackHandoffItemOffsetY:25,
    files: {
      orders:{key:'station-orders-v1',url:'/assets/art/stations/orders-v1.png'},
      ingredients:{key:'station-ingredients-v1',url:'/assets/art/stations/ingredients-v1.png'},
      prep:{key:'station-prep-v1',url:'/assets/art/stations/prep-v1.png'},
      handoff:{key:'station-handoff-v1',url:'/assets/art/stations/handoff-v1.png'},
      delivery:{key:'station-delivery-v1',url:'/assets/art/stations/delivery-v1.png'},
    },
  },
} as const;
/** Alpha-visible source frames; original PNG bytes remain untouched. */
export const KITCHEN_ART = {
  'knife': { key: 'kitchen-animation-v1-knife', url: '/assets/art/kitchen-animation-v1/knife.png', frame: { x: 130, y: 229, width: 1811, height: 343 } },
  'decor-mat-cat': { key: 'kitchen-v5-decor-mat-cat', url: '/assets/art/kitchen-v5/decor-mat-cat.png', frame: { x: 145, y: 232, width: 1357, height: 555 } },
  'decor-mat-star': { key: 'kitchen-v5-decor-mat-star', url: '/assets/art/kitchen-v5/decor-mat-star.png', frame: { x: 230, y: 292, width: 1175, height: 468 } },
  'cabinet-supply-vertical': { key: 'kitchen-v3-cabinet-supply-vertical', url: '/assets/art/kitchen-v3/cabinet-supply-vertical.png', frame: { x: 313, y: 131, width: 399, height: 1220 } },
  'cabinet-cooking-vertical': { key: 'kitchen-v3-cabinet-cooking-vertical', url: '/assets/art/kitchen-v3/cabinet-cooking-vertical.png', frame: { x: 259, y: 100, width: 512, height: 1294 } },
  'table-small-square': { key: 'kitchen-v3-table-small-square', url: '/assets/art/kitchen-v3/table-small-square.png', frame: { x: 296, y: 213, width: 780, height: 771 } },
  'counter-prep-horizontal': { key: 'kitchen-v3-counter-prep-horizontal', url: '/assets/art/kitchen-v3/counter-prep-horizontal.png', frame: { x: 188, y: 247, width: 1246, height: 606 } },
  'island-two-slot-empty': { key: 'kitchen-v3-island-two-slot-empty', url: '/assets/art/kitchen-v3/island-two-slot-empty.png', frame: { x: 538, y: 89, width: 461, height: 849 } },
  'corner-left-empty': { key: 'kitchen-v3-corner-left-empty', url: '/assets/art/kitchen-v3/corner-left-empty.png', frame: { x: 375, y: 148, width: 670, height: 849 } },
  'corner-right-empty': { key: 'kitchen-v3-corner-right-empty', url: '/assets/art/kitchen-v3/corner-right-empty.png', frame: { x: 370, y: 155, width: 660, height: 839 } },
  'prop-order-clipboard': { key: 'kitchen-v3-prop-order-clipboard', url: '/assets/art/kitchen-v3/prop-order-clipboard.png', frame: { x: 352, y: 233, width: 619, height: 722 } },
  'prop-serving-tray-bell': { key: 'kitchen-v3-prop-serving-tray-bell', url: '/assets/art/kitchen-v3/prop-serving-tray-bell.png', frame: { x: 264, y: 151, width: 1169, height: 607 } },
  'prop-stove-empty': { key: 'kitchen-v3-prop-stove-empty', url: '/assets/art/kitchen-v3/prop-stove-empty.png', frame: { x: 341, y: 201, width: 767, height: 681 } },
  'prop-cleanup-bin': { key: 'kitchen-v3-prop-cleanup-bin', url: '/assets/art/kitchen-v3/prop-cleanup-bin.png', frame: { x: 384, y: 228, width: 769, height: 569 } },
  'decor-flowers': { key: 'kitchen-v3-decor-flowers', url: '/assets/art/kitchen-v3/decor-flowers.png', frame: { x: 418, y: 307, width: 490, height: 578 } },
  'foliage-front-left': { key: 'kitchen-v3-foliage-front-left', url: '/assets/art/kitchen-v3/foliage-front-left.png', frame: { x: 79, y: 85, width: 1100, height: 844 } },
  'foliage-front-right': { key: 'kitchen-v3-foliage-front-right', url: '/assets/art/kitchen-v3/foliage-front-right.png', frame: { x: 280, y: 127, width: 1287, height: 794 } },
  'basket-cucumber': { key: 'kitchen-v2-basket-cucumber', url: '/assets/art/kitchen-v2/basket-cucumber.png', frame: { x: 134, y: 178, width: 988, height: 908 } },
  'basket-pumpkin': { key: 'kitchen-v2-basket-pumpkin', url: '/assets/art/kitchen-v2/basket-pumpkin.png', frame: { x: 226, y: 170, width: 888, height: 825 } },
  'bowl-cucumber': { key: 'kitchen-v2-bowl-cucumber', url: '/assets/art/kitchen-v2/bowl-cucumber.png', frame: { x: 123, y: 161, width: 1009, height: 924 } },
  'bowl-empty': { key: 'kitchen-v2-bowl-empty', url: '/assets/art/kitchen-v2/bowl-empty.png', frame: { x: 124, y: 164, width: 1006, height: 919 } },
  'bowl-pumpkin-salad': { key: 'kitchen-v2-bowl-pumpkin-salad', url: '/assets/art/kitchen-v2/bowl-pumpkin-salad.png', frame: { x: 122, y: 162, width: 1010, height: 922 } },
  'bowl-pumpkin-soup': { key: 'kitchen-v2-bowl-pumpkin-soup', url: '/assets/art/kitchen-v2/bowl-pumpkin-soup.png', frame: { x: 122, y: 161, width: 1010, height: 923 } },
  'bowl-pumpkin': { key: 'kitchen-v2-bowl-pumpkin', url: '/assets/art/kitchen-v2/bowl-pumpkin.png', frame: { x: 123, y: 161, width: 1008, height: 924 } },
  'bowl-stack': { key: 'kitchen-v2-bowl-stack', url: '/assets/art/kitchen-v2/bowl-stack.png', frame: { x: 124, y: 131, width: 1007, height: 1025 } },
  'counter-empty': { key: 'kitchen-v2-counter-empty', url: '/assets/art/kitchen-v2/counter-empty.png', frame: { x: 255, y: 215, width: 875, height: 749 } },
  'cream-carton': { key: 'kitchen-v2-cream-carton', url: '/assets/art/kitchen-v2/cream-carton.png', frame: { x: 408, y: 230, width: 586, height: 735 } },
  'cucumber-chopped': { key: 'kitchen-v2-cucumber-chopped', url: '/assets/art/kitchen-v2/cucumber-chopped.png', frame: { x: 188, y: 222, width: 936, height: 815 } },
  'cucumber-raw': { key: 'kitchen-v2-cucumber-raw', url: '/assets/art/kitchen-v2/cucumber-raw.png', frame: { x: 139, y: 207, width: 996, height: 879 } },
  'cutting-board-empty': { key: 'kitchen-v2-cutting-board-empty', url: '/assets/art/kitchen-v2/cutting-board-empty.png', frame: { x: 279, y: 145, width: 1216, height: 597 } },
  'pot-cream-added': { key: 'kitchen-v2-pot-cream-added', url: '/assets/art/kitchen-v2/pot-cream-added.png', frame: { x: 125, y: 117, width: 1125, height: 912 } },
  'pot-empty': { key: 'kitchen-v2-pot-empty', url: '/assets/art/kitchen-v2/pot-empty.png', frame: { x: 126, y: 120, width: 1122, height: 907 } },
  'pot-pumpkin-cooked': { key: 'kitchen-v2-pot-pumpkin-cooked', url: '/assets/art/kitchen-v2/pot-pumpkin-cooked.png', frame: { x: 125, y: 118, width: 1124, height: 911 } },
  'pot-pumpkin-raw': { key: 'kitchen-v2-pot-pumpkin-raw', url: '/assets/art/kitchen-v2/pot-pumpkin-raw.png', frame: { x: 124, y: 119, width: 1126, height: 909 } },
  'pot-soup-ready': { key: 'kitchen-v2-pot-soup-ready', url: '/assets/art/kitchen-v2/pot-soup-ready.png', frame: { x: 125, y: 119, width: 1125, height: 909 } },
  'pumpkin-chopped': { key: 'kitchen-v2-pumpkin-chopped', url: '/assets/art/kitchen-v2/pumpkin-chopped.png', frame: { x: 147, y: 170, width: 1108, height: 837 } },
  'pumpkin-cooked': { key: 'kitchen-v2-pumpkin-cooked', url: '/assets/art/kitchen-v2/pumpkin-cooked.png', frame: { x: 215, y: 184, width: 909, height: 805 } },
  'pumpkin-raw': { key: 'kitchen-v2-pumpkin-raw', url: '/assets/art/kitchen-v2/pumpkin-raw.png', frame: { x: 250, y: 200, width: 842, height: 781 } },
} as const;
export type KitchenArtId = keyof typeof KITCHEN_ART;

/** Select only confirmed game state. Containers are whole replacement images. */
export function itemArtwork(item: KitchenItem | undefined, items: Record<string, KitchenItem>): KitchenArtId | undefined {
  if (!item) return undefined;
  if (item.kind === 'ingredient') {
    if (item.ingredient === 'cream') return 'cream-carton';
    if (item.ingredient === 'pumpkin') return item.preparation === 'raw' ? 'pumpkin-raw' : item.preparation === 'cooked' ? 'pumpkin-cooked' : 'pumpkin-chopped';
    return item.preparation === 'raw' ? 'cucumber-raw' : 'cucumber-chopped';
  }
  if (item.kind === 'pot') return ({
    empty: 'pot-empty', loaded_pumpkin: 'pot-pumpkin-raw', cooking_pumpkin: 'pot-pumpkin-raw',
    cooked_pumpkin: 'pot-pumpkin-cooked', loaded_soup: 'pot-cream-added',
    cooking_soup: 'pot-cream-added', soup_ready: 'pot-soup-ready',
  } as const)[item.phase];
  if (item.recipe_id) return item.recipe_id === 'pumpkin_soup' ? 'bowl-pumpkin-soup' : 'bowl-pumpkin-salad';
  if (!item.contents.length) return 'bowl-empty';
  if (item.contents.length === 1) {
    const food = items[item.contents[0]];
    if (food?.kind === 'ingredient' && food.ingredient === 'cucumber' && food.preparation === 'chopped') return 'bowl-cucumber';
    if (food?.kind === 'ingredient' && food.ingredient === 'pumpkin' && food.preparation === 'cooked') return 'bowl-pumpkin';
  }
  return undefined;
}

/** Presentation-only geometry and colors, keyed by stable game entity IDs. */
export const ASSETS = {
  stations: {
    orders: {color:0xf0b75e,width:190,height:96},
    ingredients: {color:0x7bc2a4,width:190,height:96},
    prep: {color:0x9d8be7,width:190,height:96},
    handoff: {color:0xe5a1ce,width:190,height:96},
    delivery: {color:0x7fb7e7,width:190,height:96},
  },
  seats: {
    human: {color:0xf28eb7,radius:18,label:'Human'},
    ai: {color:0x78b8f0,radius:18,label:'AI'},
  } satisfies Record<SeatId,{color:number;radius:number;label:string}>,
  items: {
    raw: {color:0x86cb91,label:'食材'},
    dish: {color:0xf1bd6f,label:'成品'},
  },
} as const;

