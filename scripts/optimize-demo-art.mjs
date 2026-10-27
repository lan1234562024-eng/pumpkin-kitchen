import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

/** Build derivatives only: retain PNGs, coordinates, dimensions and alpha. */
export async function optimizeDemoArt(directory) {
  let files = 0, before = 0, after = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const input = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await optimizeDemoArt(input);
      files += nested.files; before += nested.before; after += nested.after;
    } else if (entry.name.endsWith('.png')) {
      const output = input.replace(/\.png$/, '.webp');
      await sharp(input).webp({ quality: 82, alphaQuality: 100, effort: 4 }).toFile(output);
      files++; before += (await stat(input)).size; after += (await stat(output)).size;
    }
  }
  return { files, before, after };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log('Demo artwork compression:', await optimizeDemoArt(resolve('dist/assets/art')));
}
