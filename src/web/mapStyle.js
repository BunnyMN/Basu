/**
 * The map this app draws.
 *
 * MapLibre GL over vector tiles we serve ourselves. The layer order and zoom
 * breakpoints are a style already proven on a phone; the palette is Basu's
 * own «Тансаг хар» and quiet on purpose — a warm charcoal ground, roads a
 * step or two lighter, water a cooler near-black, parks a breath warmer,
 * street names in the third ink and landmarks in gold — so that the one
 * thing with colour on the map is the crimson pin a guest came to find. It
 * is dark whatever the phone's own setting is, as every Basu page is: a
 * daylight map under a dark sheet was a seam, and a light phone made the
 * whole lunch page half light.
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
 * The palette, one key per thing on the map, drawn from app.css's tokens so
 * the map and the sheet over it are one material: the ground a hair above
 * the page's charcoal (#100D0C), buildings and roads climbing the surfaces
 * (#1C1716 → #3E3532), labels in the inks — the third for streets, the
 * near-white for places — and the gold, a shade under app.css's #C9A96E, for
 * the landmarks somebody steers by: present, and still quieter than a pin.
 * No green, no blue: water is a cooler charcoal, a park a warmer one.
 */
const MAP_PALETTE = {
  ground: '#141110', water: '#111518', park: '#191512', residential: '#161210',
  khashaa: '#171312', khashaaLine: '#2E2725',
  building: '#1F1A18', buildingTall: '#241E1C', buildingLine: '#2E2725',
  minorCase: '#181412', minor: '#2A2321', tertiaryCase: '#1B1614', tertiary: '#302826',
  secondaryCase: '#1D1816', secondary: '#372E2B', primaryCase: '#201A18', primary: '#3E3431',
  trunkCase: '#231C1A', trunk: '#4A3E3A', rail: '#3A302D',
  roadLabel: '#998E85', houseNumber: '#7E736B', landmark: '#A8915F', place: '#E8DFD5', halo: '#141110',
};

/**
 * The places that keep their name on our map: what a person steers by, not
 * what somebody sells. Everything else in the tiles' `poi` layer — cafés,
 * bars, banks, shops, offices, bus stops — is left unnamed.
 */
const LANDMARKS = ['memorial', 'monument', 'park', 'college', 'university', 'museum', 'theatre', 'place_of_worship', 'hospital', 'stadium', 'attraction', 'library', 'town_hall'];

/**
 * MapLibre's own words — the names a screen reader says for the map and its
 * buttons, and the tips they show — in Mongolian. MapLibre's defaults are
 * English («Zoom in», «Find my location»); a Map takes these as `locale`.
 */
export const MAP_LOCALE = {
  'Map.Title': 'Газрын зураг',
  'Marker.Title': 'Газрын зургийн тэмдэг',
  'NavigationControl.ZoomIn': 'Ойртуулах',
  'NavigationControl.ZoomOut': 'Холдуулах',
  'NavigationControl.ResetBearing': 'Хойд зүг рүү эргүүлэх',
  'GeolocateControl.FindMyLocation': 'Миний байршил',
  'GeolocateControl.LocationNotAvailable': 'Байршил тодорхойгүй',
  'AttributionControl.ToggleAttribution': 'Газрын зургийн эх сурвалж',
  'AttributionControl.MapFeedback': 'Газрын зургийн санал',
  'Popup.Close': 'Хаах',
  'CooperativeGesturesHandler.MobileHelpText': 'Газрын зургийг хоёр хуруугаар хөдөлгөнө',
};

/** The map's style: one palette, the dark one, whatever the phone's appearance. */
export function mapStyle() {
  const c = MAP_PALETTE;
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
