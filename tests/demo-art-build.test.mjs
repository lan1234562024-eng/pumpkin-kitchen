import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { optimizeDemoArt } from '../scripts/optimize-demo-art.mjs';
it('creates WebP with the original geometry and alpha, without changing source PNG', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'pumpkin-art-test-'));
 try {
  const input = join(dir, 'sprite.png');
  await sharp({create:{width:32,height:24,channels:4,background:{r:230,g:90,b:20,alpha:.5}}}).png().toFile(input);
  const before = await readFile(input); const result = await optimizeDemoArt(dir);
  expect(existsSync(join(dir,'sprite.webp'))).toBe(true);
  const metadata = await sharp(join(dir,'sprite.webp')).metadata();
  expect(metadata.width).toBe(32); expect(metadata.height).toBe(24); expect(metadata.hasAlpha).toBe(true);
  expect(await readFile(input)).toEqual(before); expect(result.files).toBe(1);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
