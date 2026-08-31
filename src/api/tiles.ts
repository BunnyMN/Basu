import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Map tiles and label glyphs, served from our own origin.
 *
 * The vector tiles are Mongolia's, rendered from OpenStreetMap by a Martin
 * instance the FuelNet project already runs. The reasoning for hosting rather
 * than buying is theirs and holds here unchanged: tiles cost the server they
 * run on and nothing per view, they carry Mongolian detail no global provider
 * has — khashaa boundaries, local POI names — and a Google Dynamic Map is
 * billed per load. Every office worker in a tower opening the app at noon is
 * exactly the shape of traffic that per-load pricing punishes.
 *
 * # Why a proxy rather than pointing the browser at the tile host
 *
 * That host's nginx and the Martin behind it both add
 * `Access-Control-Allow-Origin`, so a browser sees the header twice and
 * refuses the response outright. Every tile fails and the map draws its
 * background colour and nothing else. It is somebody else's nginx to fix, and
 * a deployment reaching across the internet on every pan is resting on their
 * uptime and bandwidth without appearing in their capacity planning. A
 * same-origin request has no CORS to get wrong.
 *
 * `MAP_TILES_UPSTREAM` is the seam: point it at a Martin of our own over a
 * copy of the same data and nothing in the client changes.
 */

const DEFAULT_UPSTREAM = 'https://monzasvar.mn';

/** A day in the browser, a week at any CDN in front of us. Tiles rarely move. */
const CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';

function upstream(): string {
  return (process.env['MAP_TILES_UPSTREAM'] ?? DEFAULT_UPSTREAM).replace(/\/$/, '');
}

/** Reject anything that is not the shape of a tile or glyph path. */
const TILE_PATH = /^\d{1,2}\/\d{1,7}\/\d{1,7}$/;
const GLYPH_PATH = /^[\w %.-]{1,64}\/\d{1,6}-\d{1,6}\.pbf$/;

export async function registerMapRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { z: string; x: string; y: string } }>(
    '/tiles/:z/:x/:y',
    async (request, reply) => {
      const { z, x, y } = request.params;
      const path = `${z}/${x}/${y}`;
      if (!TILE_PATH.test(path)) return reply.status(400).send();
      return pipe(`tiles/${path}`, reply);
    },
  );

  app.get<{ Params: { fontstack: string; range: string } }>(
    '/fonts/:fontstack/:range',
    async (request, reply) => {
      const path = `${request.params.fontstack}/${request.params.range}`;
      if (!GLYPH_PATH.test(decodeURIComponent(path))) return reply.status(400).send();
      return pipe(`fonts/${path}`, reply);
    },
  );
}

async function pipe(path: string, reply: FastifyReply) {
  let response: Response;
  try {
    response = await fetch(`${upstream()}/${path}`, { headers: { accept: '*/*' } });
  } catch {
    // The tile host is unreachable. 502, not 500: this process is fine, the
    // thing it depends on is not, and a monitor should be able to tell.
    return reply.status(502).send();
  }

  // Martin answers 204 for a tile with no data in it, which is most of the
  // country outside Ulaanbaatar. MapLibre reads that as "nothing here" and
  // moves on; turning it into a 404 would make an empty tile look broken.
  if (response.status === 204) {
    return reply.status(204).header('cache-control', CACHE_CONTROL).send();
  }
  if (!response.ok) return reply.status(response.status).send();

  const body = Buffer.from(await response.arrayBuffer());
  reply.header('cache-control', CACHE_CONTROL);
  const type = response.headers.get('content-type');
  if (type) reply.header('content-type', type);

  // `content-encoding` is deliberately not forwarded. fetch negotiates gzip and
  // decodes the body before handing it over, but the response headers still
  // describe the encoding it removed. Passing that along tells the browser to
  // gunzip plain protobuf: it fails, every tile is discarded, and the map draws
  // its background colour with the markers still on top — so the failure looks
  // like a styling problem rather than a transport one.
  return reply.send(body);
}
