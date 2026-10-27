export type ArtLoadState = { progress: number; failed: number; ready: boolean };
type LoaderEvents = { on(event: string, listener: (...args: any[]) => void): unknown; off(event: string, listener: (...args: any[]) => void): unknown };
/** Report actual loader events; progress is file completion, not transferred bytes. */
export function watchArtLoading(loader: LoaderEvents, notify: (state: ArtLoadState) => void): () => void {
  let progress = 0, failed = 0, disposed = false;
  const report = (ready = false) => { if (!disposed) notify({ progress, failed, ready }); };
  const onProgress = (value: number) => { progress = Math.max(0, Math.min(1, value)); report(); };
  const onError = () => { failed++; report(); };
  const onComplete = () => { progress = 1; report(true); };
  loader.on('progress', onProgress); loader.on('loaderror', onError); loader.on('complete', onComplete);
  report();
  return () => { disposed = true; loader.off('progress', onProgress); loader.off('loaderror', onError); loader.off('complete', onComplete); };
}
export function artUrl(url: string, base: string, mode: string, optimized = true): string {
  const path = mode === 'demo' && optimized ? url.replace(/\.png$/, '.webp') : url;
  return `${base}${path.replace(/^\//, '')}`;
}
