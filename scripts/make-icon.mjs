// Regenerates build/icon.png and build/icon.ico from build/icon.svg. Not part
// of the normal build — run by hand after editing the icon design, via:
//   npm install --no-save sharp png-to-ico && node scripts/make-icon.mjs
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svgPath = path.join(root, 'build', 'icon.svg');
const svg = await fs.readFile(svgPath);

// The 1024px master is what electron-builder uses directly for macOS/Linux icon sets.
await sharp(svg, { density: 384 }).resize(1024, 1024).png().toFile(path.join(root, 'build', 'icon.png'));

// Windows .ico is a container of several fixed sizes, largest first — built from
// its own crisp render at each size rather than downscaling once, so small sizes
// don't inherit anti-aliasing softness meant for the 1024px version.
const sizes = [256, 128, 64, 48, 32, 16];
const buffers = await Promise.all(
  sizes.map((size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer())
);
const ico = await pngToIco(buffers);
await fs.writeFile(path.join(root, 'build', 'icon.ico'), ico);

console.log('[icon] wrote build/icon.png (1024) and build/icon.ico (256..16)');
