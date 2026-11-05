import { layers, namedFlavor } from '@protomaps/basemaps';
const [flavor, lang, out] = process.argv.slice(2);
const style = {
  version: 8,
  name: `Nex Map ${flavor}`,
  // tileserver-gl resolves these against its fonts/ and the style's folder.
  glyphs: '{fontstack}/{range}.pbf',
  sprite: `{styleJsonFolder}/sprites/${flavor}`,
  sources: {
    protomaps: {
      type: 'vector',
      url: 'pmtiles://{planet}',
      attribution: '© OpenStreetMap contributors · Protomaps',
    },
  },
  layers: layers('protomaps', namedFlavor(flavor), { lang }),
};
const fs = await import('node:fs');
fs.writeFileSync(out, JSON.stringify(style, null, 1));
const fonts = new Set();
for (const l of style.layers) for (const f of l.layout?.['text-font'] ?? []) fonts.add(f);
console.log(out, style.layers.length, 'layers; fonts:', [...fonts].join(', '));
