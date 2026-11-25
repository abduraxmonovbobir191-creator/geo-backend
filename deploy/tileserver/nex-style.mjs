// Nex Map's own map design (not the stock Protomaps look): brand colours for light and dark, 3D buildings,
// and our POI icons. Run:  npm i @protomaps/basemaps@5.7.2 && node nex-style.mjs
// It writes styles/light.json and styles/dark.json (tileserver-gl serves them as vector styles and as PNG tiles).
import fs from 'node:fs';
import { layers, namedFlavor } from '@protomaps/basemaps';

const PALETTE = {
  light: {
    background: '#eef2f0', earth: '#f3f5f2', water: '#b9dff0', park_a: '#cfe9d8', park_b: '#c2e3cd', wood_a: '#bfe0c9', wood_b: '#b4dac0',
    scrub_a: '#d3e8d4', scrub_b: '#c9e2cc', sand: '#f1e9cf', beach: '#f1e9cf', hospital: '#f9e1e1', school: '#f4ecd3', industrial: '#e7e9e6',
    pedestrian: '#f8faf8', buildings: '#dfe4e1', minor_a: '#ffffff', minor_b: '#ffffff', major: '#ffffff', highway: '#ffe0a8',
    link: '#ffffff', railway: '#b9c2bd', boundaries: '#9aa8a0', glacier: '#ffffff',
    city_label: '#1b2a24', subplace_label: '#4a5c54', state_label: '#7a8c83', country_label: '#5a6d64',
    roads_label_minor: '#6b7c74', roads_label_major: '#44564d', ocean_label: '#6aa0b8',
  },
  dark: {
    background: '#0d1411', earth: '#111a16', water: '#0f2a3a', park_a: '#14291c', park_b: '#122418', wood_a: '#12291d', wood_b: '#10241a',
    scrub_a: '#14261a', scrub_b: '#132318', sand: '#2a281c', beach: '#2a281c', hospital: '#2b1a1c', school: '#252218', industrial: '#171f1b',
    pedestrian: '#1a2520', buildings: '#1c2823', minor_a: '#26332d', minor_b: '#26332d', major: '#2f3d36', highway: '#4a4332',
    link: '#26332d', railway: '#35443c', boundaries: '#4a5a51', glacier: '#2a3a36',
    city_label: '#e4efe9', subplace_label: '#a9bbb1', state_label: '#7d8f85', country_label: '#a2b4aa',
    roads_label_minor: '#7d8f85', roads_label_major: '#b4c6bc', ocean_label: '#4d8aa6',
  },
};
// 3D buildings: the extrusion layer shows from zoom 14 and takes over from the flat footprints.
const BUILDING_3D = {
  light: { color: '#d3d9d6', top: '#e8ecea' },
  dark: { color: '#24332c', top: '#2f4037' },
};

for (const flavor of ['light', 'dark']) {
  const theme = { ...namedFlavor(flavor), ...PALETTE[flavor] };
  const base = layers('protomaps', theme, { lang: 'en' });
  const flat = base.map((l) => (l.id === 'buildings' ? { ...l, maxzoom: 14 } : l));
  const at = flat.findIndex((l) => l.id === 'buildings');
  const extrusion = {
    id: 'buildings_3d',
    type: 'fill-extrusion',
    source: 'protomaps',
    'source-layer': 'buildings',
    minzoom: 14,
    filter: ['!=', ['get', 'kind'], 'building_part'],
    paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'height'], 10], 0, BUILDING_3D[flavor].top, 80, BUILDING_3D[flavor].color],
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, ['coalesce', ['get', 'height'], 10]],
      'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, ['coalesce', ['get', 'min_height'], 0]],
      'fill-extrusion-opacity': 0.92,
      'fill-extrusion-vertical-gradient': true,
    },
  };
  flat.splice(at + 1, 0, extrusion);
  const style = {
    version: 8,
    name: `Nex Map ${flavor}`,
    glyphs: '{fontstack}/{range}.pbf',
    sprite: `{styleJsonFolder}/sprites/${flavor}`,
    center: [69.2401, 41.2995],
    zoom: 12,
    pitch: 45, // clients open the map tilted so the 3D buildings show
    sources: { protomaps: { type: 'vector', url: 'pmtiles://{planet}', attribution: '© OpenStreetMap contributors · Protomaps' } },
    layers: flat,
  };
  fs.writeFileSync(new URL(`styles/${flavor}.json`, import.meta.url), JSON.stringify(style, null, 1));
  console.log(flavor, style.layers.length, 'layers');
}
