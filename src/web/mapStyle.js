/**
 * The map this app draws.
 *
 * MapLibre GL over vector tiles we serve ourselves. The layer order and zoom
 * breakpoints are a style already proven on a phone in daylight; the palette
 * is Basu's own and quiet on purpose — warm greys, white roads, water and
 * parks only just tinted — so that the one thing with contrast on the map is
 * the pin a guest came to find. At night it is the app's own dark: a
 * pine-black ground, roads a step lighter, labels in the second ink.
 *
 * What it does not draw is as deliberate. The tiles carry every café, bar,
 * bank and shop in the city; on a map that sells lunch at the restaurants
 * that are ours, those are other people's businesses written over the
 * streets, so only landmarks keep their names — a monument, a park, a
 * university, the government palace — which is how somebody finds a door.
 *
 * Both URLs are on this origin: /tiles and /fonts proxy the upstream, and
 * src/api/tiles.ts says why.
 */

/**
 * Absolute, not relative — and this is not a style preference.
 *
 * MapLibre fetches tiles from a Web Worker, which has no document to resolve a
 * relative path against, so `/tiles/{z}/{x}/{y}` reaches `new Request()` as-is
 * and throws "Failed to parse URL". The failure is reported on the map's error
 * channel and nowhere else: the map draws its background colour with the
 * markers still on top, which looks like a styling problem and is a transport
 * one. Building the URL from `location.origin` keeps it same-origin — the whole
 * reason the tiles are proxied — while giving the worker something it can parse.
 */
const origin = typeof location === 'undefined' ? '' : location.origin;

export const TILE_URL = `${origin}/tiles/{z}/{x}/{y}`;
export const GLYPHS_URL = `${origin}/fonts/{fontstack}/{range}.pbf`;

/** Sükhbaatar Square — where the map opens when we have nothing better. */
export const ULAANBAATAR = { lat: 47.9185, lon: 106.9175 };

/**
 * Mongolia, rounded outward a little so border towns and GPS drift are not
 * pulled back to the capital. The tiles cover this and nothing else, so a map
 * centred outside it draws the background colour and reads as broken.
 */
export const BOUNDS = { minLat: 41.4, maxLat: 52.3, minLon: 87.5, maxLon: 120.2 };

export function isCovered(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false; // a dropped fix arrives as 0,0
  return (
    lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon
  );
}

/**
 * The two palettes, one key per thing on the map. Light is the daylight
 * style as it was proven; dark is drawn from the app's dark tokens (ground
 * #0F1110, surface #171A18, lines #29302B, ink-2 #AEB5AD) so the map and the
 * sheet over it are one material, with water in the same blue-black as the
 * unread wash and parks a breath of pine.
 */
const MAP_PALETTES = {
  light: {
    ground: '#F4F3EE', water: '#CFDCE4', park: '#DCE3D3', residential: '#ECEAE6',
    khashaa: '#F1EFEB', khashaaLine: '#CFCBC4',
    building: '#E4E1DC', buildingTall: '#E1DED8', buildingLine: '#D3CFC8',
    minorCase: '#E2DFDA', minor: '#FFFFFF', tertiaryCase: '#DAD6CF', tertiary: '#FFFFFF',
    secondaryCase: '#D6D2CB', secondary: '#FFFFFF', primaryCase: '#CCC7BF', primary: '#FFFFFF',
    trunkCase: '#BDB7AE', trunk: '#FDFCFA', rail: '#BDBAB5',
    roadLabel: '#6B665F', houseNumber: '#8C8780', landmark: '#4E6B80', place: '#2B2926', halo: '#FFFFFF',
  },
  dark: {
    ground: '#111412', water: '#16232E', park: '#13231B', residential: '#151917',
    khashaa: '#161A18', khashaaLine: '#2B322D',
    building: '#1B201D', buildingTall: '#1E2420', buildingLine: '#262C28',
    minorCase: '#171B19', minor: '#262C28', tertiaryCase: '#1A1F1C', tertiary: '#2D342F',
    secondaryCase: '#1C221E', secondary: '#343C36', primaryCase: '#1E2420', primary: '#3C453F',
    trunkCase: '#202722', trunk: '#475049', rail: '#353D37',
    roadLabel: '#8D958C', houseNumber: '#6F776F', landmark: '#8FA7B8', place: '#DDE2DC', halo: '#111412',
  },
};

/**
 * The places that keep their name on our map: what a person steers by, not
 * what somebody sells. Everything else in the tiles' `poi` layer — cafés,
 * bars, banks, shops, offices, bus stops — is left unnamed.
 */
const LANDMARKS = ['memorial', 'monument', 'park', 'college', 'university', 'museum', 'theatre', 'place_of_worship', 'hospital', 'stadium', 'attraction', 'library', 'town_hall'];

/** `'dark'` or `'light'`: the page's theme — pinned by `data-theme`, else the phone's. */
export function mapTheme() {
  if (typeof document === 'undefined') return 'light';
  const pinned = document.documentElement.getAttribute('data-theme');
  if (pinned === 'dark' || pinned === 'light') return pinned;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Call `paint(theme)` when the phone changes appearance while the page is
 * open — iOS turns dark at sunset by itself, and a map left in daylight
 * under a dark sheet is the seam this is here to remove.
 */
export function onMapTheme(paint) {
  if (typeof matchMedia !== 'function') return;
  const query = matchMedia('(prefers-color-scheme: dark)');
  const changed = () => paint(mapTheme());
  if (query.addEventListener) query.addEventListener('change', changed);
  else query.addListener?.(changed);
}

/** Put a map already drawn into `theme`'s palette, layer by layer, without reloading anything. */
export function repaintMap(map, theme) {
  for (const layer of mapStyle(theme).layers) {
    if (!map.getLayer?.(layer.id)) continue;
    for (const [key, value] of Object.entries(layer.paint ?? {})) map.setPaintProperty(layer.id, key, value);
  }
}

export function mapStyle(theme = 'light') {
  const c = MAP_PALETTES[theme === 'dark' ? 'dark' : 'light'];
  return {
    version: 8,
    name: 'Basu',
    sources: { base: { type: 'vector', tiles: [TILE_URL], minzoom: 0, maxzoom: 16 } },
    glyphs: GLYPHS_URL,
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': c.ground } },
      { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water',
        paint: { 'fill-color': c.water } },
      { id: 'park', type: 'fill', source: 'base', 'source-layer': 'landuse',
        filter: ['in', 'class', 'park', 'grass'],
        paint: { 'fill-color': c.park, 'fill-opacity': 0.7 } },
      { id: 'residential', type: 'fill', source: 'base', 'source-layer': 'landuse',
        filter: ['==', 'class', 'residential'],
        paint: { 'fill-color': c.residential, 'fill-opacity': 0.5 } },
      { id: 'khashaa-fill', type: 'fill', source: 'base', 'source-layer': 'landuse',
        filter: ['==', 'class', 'khashaa'], minzoom: 13,
        paint: { 'fill-color': c.khashaa,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.1, 15, 0.5] } },
      { id: 'khashaa', type: 'line', source: 'base', 'source-layer': 'landuse',
        filter: ['==', 'class', 'khashaa'], minzoom: 14,
        paint: { 'line-color': c.khashaaLine, 'line-width': 0.8, 'line-dasharray': [4, 3] } },
      { id: 'building-2d', type: 'fill', source: 'base', 'source-layer': 'building',
        minzoom: 13, maxzoom: 15,
        paint: { 'fill-color': c.building,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.3, 15, 0.9] } },
      { id: 'building-3d', type: 'fill-extrusion', source: 'base', 'source-layer': 'building',
        minzoom: 15,
        paint: {
          'fill-extrusion-color': c.buildingTall,
          'fill-extrusion-height': ['*', ['coalesce', ['get', 'render_height'], 3], 5],
          'fill-extrusion-base': ['*', ['coalesce', ['get', 'render_min_height'], 0], 5],
          'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 17, 0.9],
        } },
      { id: 'building-outline', type: 'line', source: 'base', 'source-layer': 'building',
        minzoom: 14, paint: { 'line-color': c.buildingLine, 'line-width': 0.5 } },

      { id: 'road-minor-bg', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', 'class', 'minor', 'service'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.minorCase,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 7] } },
      { id: 'road-minor', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', 'class', 'minor', 'service'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.minor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 16, 5] } },
      { id: 'road-tertiary-bg', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'tertiary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.tertiaryCase,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 9] } },
      { id: 'road-tertiary', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'tertiary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.tertiary,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 7] } },
      { id: 'road-secondary-bg', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'secondary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.secondaryCase,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 16, 10] } },
      { id: 'road-secondary', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'secondary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.secondary,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 16, 8] } },
      { id: 'road-primary-bg', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'primary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.primaryCase,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 16, 12] } },
      { id: 'road-primary', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'primary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.primary,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 16, 10] } },
      { id: 'road-trunk-bg', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', 'class', 'trunk', 'motorway'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.trunkCase,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 16, 14] } },
      { id: 'road-trunk', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', 'class', 'trunk', 'motorway'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.trunk,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 16, 12] } },
      { id: 'rail', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'rail'],
        paint: { 'line-color': c.rail, 'line-width': 1.5, 'line-dasharray': [3, 3] } },

      { id: 'road-label', type: 'symbol', source: 'base', 'source-layer': 'transportation_name',
        minzoom: 13,
        layout: { 'text-field': '{name}', 'text-size': 11, 'symbol-placement': 'line',
          'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': c.roadLabel, 'text-halo-color': c.halo, 'text-halo-width': 1.5 } },
      { id: 'housenumber', type: 'symbol', source: 'base', 'source-layer': 'housenumber',
        minzoom: 16,
        layout: { 'text-field': '{housenumber}', 'text-size': 10,
          'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': c.houseNumber, 'text-halo-color': c.halo, 'text-halo-width': 1 } },
      // Landmarks only. The building names went with the businesses: in these
      // tiles a building is as often «Кафе», «Ресторан» or a bank as it is a
      // museum, and «Ресторан» written where nobody serves lunch is a lie on
      // a map that sells lunch.
      { id: 'poi-label', type: 'symbol', source: 'base', 'source-layer': 'poi',
        minzoom: 15,
        filter: ['all', ['has', 'name'], ['any',
          ['in', 'class', ...LANDMARKS],
          ['all', ['==', 'class', 'office'], ['==', 'subclass', 'government']]]],
        layout: { 'text-field': '{name}', 'text-size': 11, 'text-font': ['Noto Sans Regular'],
          'text-anchor': 'center', 'text-max-width': 8 },
        paint: { 'text-color': c.landmark, 'text-halo-color': c.halo, 'text-halo-width': 1.2 } },
      { id: 'place-label', type: 'symbol', source: 'base', 'source-layer': 'place',
        filter: ['has', 'name'],
        layout: { 'text-field': '{name}',
          'text-size': ['match', ['get', 'class'], 'city', 18, 'town', 14, 'suburb', 12, 10],
          'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': c.place, 'text-halo-color': c.halo, 'text-halo-width': 2 } },
    ],
  };
}

/**
 * The pin a restaurant is drawn as: a teardrop with a bowl on it.
 *
 * Generated here rather than shipped as a PNG, because the palette is a product
 * decision that will move and a file in /public would be one more thing to
 * redraw the day it does. Two colours — open and shut — because that is the one
 * distinction a guest has to make before tapping. The page passes its own
 * tokens: `colour` is the fill (accent open, third ink shut), `ring` the
 * surface it is drawn on, `glyph` what sits on the fill (on-accent).
 */
export function pinImage(colour, dim, ring = '#ffffff', glyph = ring) {
  const W = 44;
  const H = 58;
  const S = 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * S;
  canvas.height = H * S;
  const g = canvas.getContext('2d');
  g.scale(S, S);

  g.beginPath();
  g.moveTo(22, 56);
  g.bezierCurveTo(22, 56, 4, 34, 4, 21);
  g.arc(22, 21, 18, Math.PI, 0, false);
  g.bezierCurveTo(40, 34, 22, 56, 22, 56);
  g.closePath();
  g.fillStyle = colour;
  g.globalAlpha = dim ? 0.7 : 1;
  g.fill();
  g.globalAlpha = 1;
  g.lineWidth = 2;
  g.strokeStyle = ring;
  g.stroke();

  // A bowl on its foot with one wisp of steam. The old glyph — a half-circle
  // under two curls — read as a smiling face at the size a pin is drawn.
  g.fillStyle = glyph;
  g.strokeStyle = glyph;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(11.5, 20.5);
  g.lineTo(32.5, 20.5);
  g.quadraticCurveTo(31.5, 30, 22, 30.5);
  g.quadraticCurveTo(12.5, 30, 11.5, 20.5);
  g.closePath();
  g.fill();
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(18, 33);
  g.lineTo(26, 33);
  g.stroke();
  g.lineWidth = 1.8;
  g.beginPath();
  g.moveTo(22, 16.5);
  g.bezierCurveTo(19.4, 14.6, 24.6, 12.4, 22, 9.5);
  g.stroke();

  return {
    width: canvas.width,
    height: canvas.height,
    data: new Uint8Array(g.getImageData(0, 0, canvas.width, canvas.height).data.buffer),
  };
}

/** Metres between two coordinates. Haversine; the distances here are small. */
export function metresBetween(a, b) {
  const R = 6_371_000;
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dφ = φ2 - φ1;
  const dλ = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Roughly 80 metres a minute, which is an unhurried office-worker's walk. */
export function walkMinutes(metres) {
  return Math.max(1, Math.round(metres / 80));
}
