import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { watchArtLoading, artUrl } from '../src/client/game/art-loading';

describe('art loading visibility and subpath delivery', () => {
  it('reports loading immediately, then progress and errors, and cleans listeners', () => {
    const loader = new EventEmitter(); const states: any[] = [];
    const dispose = watchArtLoading(loader, state => states.push(state));
    expect(states).toEqual([{ progress: 0, failed: 0, ready: false }]);
    loader.emit('progress', .5); loader.emit('loaderror');
    expect(states.at(-1)).toEqual({ progress: .5, failed: 1, ready: false });
    dispose(); const n = states.length; loader.emit('progress', 1);
    expect(states).toHaveLength(n); expect(loader.listenerCount('progress')).toBe(0);
  });
  it('uses small same-origin WebP only in demo mode and preserves repository subpaths', () => {
    expect(artUrl('/assets/art/pot.png', './', 'demo')).toBe('./assets/art/pot.webp');
    expect(artUrl('/assets/art/pot.png', '/pumpkin-kitchen/', 'demo')).toBe('/pumpkin-kitchen/assets/art/pot.webp');
    expect(artUrl('/assets/art/pot.png', '/', 'demo', false)).toBe('/assets/art/pot.png');
    expect(artUrl('/assets/art/pot.png', '/', 'development')).toBe('/assets/art/pot.png');
  });
});

it('reports completion even with failed artwork so fallback rendering can start', () => {
 const loader = new EventEmitter(); const states: any[] = [];
 const dispose = watchArtLoading(loader, state => states.push(state));
 loader.emit('loaderror'); loader.emit('complete');
 expect(states.at(-1)).toEqual({progress:1,failed:1,ready:true});
 dispose(); expect(loader.listenerCount('loaderror')).toBe(0); expect(loader.listenerCount('complete')).toBe(0);
});
