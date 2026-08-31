import type { FastifyInstance } from 'fastify';

/**
 * How far it is to the restaurant, and how long that walk takes.
 *
 * The straight-line distance between two points in a city is a lie of about
 * thirty per cent — buildings are in the way. So the road geometry comes from
 * an OSRM instance, and the app draws the line somebody would actually walk.
 *
 * # The duration is ours, not OSRM's
 *
 * The public OSRM demo answers `/foot/` and `/walking/` with the car profile:
 * the same request returns 910 metres in 87 seconds, which is 37 km/h and not
 * a walk. Its *geometry* and *distance* are still road distance and are worth
 * having, so we take those and work the time out from the distance ourselves.
 *
 * # When it is unreachable
 *
 * A public demo server is a courtesy, not a dependency. If it does not answer,
 * the caller gets a straight line marked `direct` — the client draws that
 * dashed rather than solid, so a guess never looks like a surveyed route.
 * `ROUTER_URL` points at an OSRM of our own the day that matters.
 */

const DEFAULT_ROUTER = 'https://router.project-osrm.org';

/**
 * Metres a minute on foot. An office worker crossing a district at lunchtime,
 * not a hiker: 4.8 km/h. The same constant the walk estimates in the seed use.
 */
const METRES_PER_MINUTE = 80;

/** Straight-line distance under-reports city walking by roughly this much. */
const DETOUR_FACTOR = 1.3;

export interface Route {
  kind: 'road' | 'direct';
  metres: number;
  minutes: number;
  /** [lon, lat] pairs, ready for a GeoJSON LineString. */
  line: Array<[number, number]>;
}

const COORD = /^-?\d{1,3}(\.\d{1,7})?,-?\d{1,2}(\.\d{1,7})?$/;

export function walkMinutes(metres: number): number {
  return Math.max(1, Math.round(metres / METRES_PER_MINUTE));
}

/** Haversine. The distances here are short enough that the earth is a sphere. */
export function metresBetween(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const φ1 = (a[1] * Math.PI) / 180;
  const φ2 = (b[1] * Math.PI) / 180;
  const dφ = φ2 - φ1;
  const dλ = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function findRoute(
  from: [number, number],
  to: [number, number],
): Promise<Route> {
  const base = (process.env['ROUTER_URL'] ?? DEFAULT_ROUTER).replace(/\/$/, '');
  const url =
    `${base}/route/v1/foot/${from[0]},${from[1]};${to[0]},${to[1]}` +
    '?overview=full&geometries=geojson';

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return direct(from, to);

    const body = (await response.json()) as {
      code?: string;
      routes?: Array<{ distance?: number; geometry?: { coordinates?: Array<[number, number]> } }>;
    };
    const best = body.routes?.[0];
    const line = best?.geometry?.coordinates;
    if (body.code !== 'Ok' || !best?.distance || !line?.length) return direct(from, to);

    const metres = Math.round(best.distance);
    return { kind: 'road', metres, minutes: walkMinutes(metres), line };
  } catch {
    // Timed out, offline, or rate-limited. A straight line still answers the
    // question well enough to decide where to have lunch.
    return direct(from, to);
  }
}

function direct(from: [number, number], to: [number, number]): Route {
  const metres = Math.round(metresBetween(from, to) * DETOUR_FACTOR);
  return { kind: 'direct', metres, minutes: walkMinutes(metres), line: [from, to] };
}

export async function registerRouteRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { from?: string; to?: string } }>('/v1/route', async (request, reply) => {
    const { from, to } = request.query;
    if (!from || !to || !COORD.test(from) || !COORD.test(to)) {
      return reply.status(400).send({
        error: {
          code: 'BAD_COORDS',
          message_mn: 'Байршил танигдсангүй.',
          message_en: 'from and to must be lon,lat',
        },
      });
    }
    const parse = (s: string) => s.split(',').map(Number) as [number, number];
    const route = await findRoute(parse(from), parse(to));
    // Roads do not move; a browser may keep this for the walk itself.
    return reply.header('cache-control', 'public, max-age=300').send(route);
  });
}
