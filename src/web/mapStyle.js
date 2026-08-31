/**
 * The map this app draws.
 *
 * MapLibre GL over vector tiles we serve ourselves. The style is the FuelNet
 * project's, ported from its TypeScript unchanged — layer order, colours and
 * zoom breakpoints included. It is a style somebody has already looked at on a
 * phone in daylight, which is worth more than one that reads well in a diff.
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

export function mapStyle() {
  return {
    version: 8,
    name: 'Basu',
    sources: { base: { type: 'vector', tiles: [TILE_URL], minzoom: 0, maxzoom: 16 } },
    glyphs: GLYPHS_URL,
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#f5f3ef' } },
      { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water',
        paint: { 'fill-color': '#b6d6f0' } },
      { id: 'park', type: 'fill', source: 'base', 'source-layer': 'landuse',
        filter: ['in', 'class', 'park', 'grass'],
        paint: { 'fill-color': '#d8ecc8', 'fill-opacity': 0.7 } },
      { id: 'residential', type: 'fill', source: 'base', 'source-layer': 'landuse',
        filter: ['==', 'class', 'residential'],
        paint: { 'fill-color': '#eeebe5', 'fill-opacity': 0.5 } },
      { id: 'khashaa-fill', type: 'fill', source: 'base', 'source-layer': 'landuse',
        filter: ['==', 'class', 'khashaa'], minzoom: 13,
        paint: { 'fill-color': '#f5f0e8',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.1, 15, 0.5] } },
      { id: 'khashaa', type: 'line', source: 'base', 'source-layer': 'landuse',
        filter: ['==', 'class', 'khashaa'], minzoom: 14,
        paint: { 'line-color': '#c8c4bc', 'line-width': 0.8, 'line-dasharray': [4, 3] } },
      { id: 'building-2d', type: 'fill', source: 'base', 'source-layer': 'building',
        minzoom: 13, maxzoom: 15,
        paint: { 'fill-color': '#e0dcd6',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.3, 15, 0.9] } },
      { id: 'building-3d', type: 'fill-extrusion', source: 'base', 'source-layer': 'building',
        minzoom: 15,
        paint: {
          'fill-extrusion-color': '#ddd8d0',
          'fill-extrusion-height': ['*', ['coalesce', ['get', 'render_height'], 3], 5],
          'fill-extrusion-base': ['*', ['coalesce', ['get', 'render_min_height'], 0], 5],
          'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 17, 0.9],
        } },
      { id: 'building-outline', type: 'line', source: 'base', 'source-layer': 'building',
        minzoom: 14, paint: { 'line-color': '#ccc7be', 'line-width': 0.5 } },

      { id: 'road-minor-bg', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', 'class', 'minor', 'service'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#e0dcd6',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 7] } },
      { id: 'road-minor', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', 'class', 'minor', 'service'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 16, 5] } },
      { id: 'road-tertiary-bg', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'tertiary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#d8d3cb',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 9] } },
      { id: 'road-tertiary', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'tertiary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 7] } },
      { id: 'road-secondary-bg', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'secondary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#d4a853',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 16, 10] } },
      { id: 'road-secondary', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'secondary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f5deb3',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 16, 8] } },
      { id: 'road-primary-bg', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'primary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#d4a24a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 16, 12] } },
      { id: 'road-primary', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'primary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f0c77b',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 16, 10] } },
      { id: 'road-trunk-bg', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', 'class', 'trunk', 'motorway'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#c9913a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 16, 14] } },
      { id: 'road-trunk', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', 'class', 'trunk', 'motorway'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f0c06b',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 16, 12] } },
      { id: 'rail', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['==', 'class', 'rail'],
        paint: { 'line-color': '#bbbbbb', 'line-width': 1.5, 'line-dasharray': [3, 3] } },

      { id: 'road-label', type: 'symbol', source: 'base', 'source-layer': 'transportation_name',
        minzoom: 13,
        layout: { 'text-field': '{name}', 'text-size': 11, 'symbol-placement': 'line',
          'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': '#777777', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } },
      { id: 'building-label', type: 'symbol', source: 'base', 'source-layer': 'building',
        minzoom: 15, filter: ['has', 'name'],
        layout: { 'text-field': '{name}', 'text-size': 11, 'text-font': ['Noto Sans Regular'],
          'text-max-width': 8 },
        paint: { 'text-color': '#555555', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } },
      { id: 'housenumber', type: 'symbol', source: 'base', 'source-layer': 'housenumber',
        minzoom: 16,
        layout: { 'text-field': '{housenumber}', 'text-size': 10,
          'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': '#999999', 'text-halo-color': '#ffffff', 'text-halo-width': 1 } },
      { id: 'poi-label', type: 'symbol', source: 'base', 'source-layer': 'poi',
        minzoom: 15, filter: ['has', 'name'],
        layout: { 'text-field': '{name}', 'text-size': 11, 'text-font': ['Noto Sans Regular'],
          'text-anchor': 'center', 'text-max-width': 8 },
        paint: { 'text-color': '#2a7ab5', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } },
      { id: 'place-label', type: 'symbol', source: 'base', 'source-layer': 'place',
        filter: ['has', 'name'],
        layout: { 'text-field': '{name}',
          'text-size': ['match', ['get', 'class'], 'city', 18, 'town', 14, 'suburb', 12, 10],
          'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': '#333333', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } },
    ],
  };
}

/**
 * The pin a restaurant is drawn as: a teardrop with a bowl on it.
 *
 * Generated here rather than shipped as a PNG, because the palette is a product
 * decision that will move and a file in /public would be one more thing to
 * redraw the day it does. Two colours — open and shut — because that is the one
 * distinction a guest has to make before tapping.
 */
export function pinImage(colour, dim) {
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
  g.globalAlpha = dim ? 0.55 : 1;
  g.fill();
  g.globalAlpha = 1;
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(255,255,255,.9)';
  g.stroke();

  // A bowl with steam: legible at 22 device pixels, which a fork is not.
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(13, 22);
  g.lineTo(31, 22);
  g.arc(22, 22, 9, 0, Math.PI, false);
  g.closePath();
  g.stroke();
  g.beginPath();
  g.moveTo(18, 14);
  g.quadraticCurveTo(20, 11, 18, 8);
  g.moveTo(26, 14);
  g.quadraticCurveTo(28, 11, 26, 8);
  g.lineWidth = 1.6;
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
