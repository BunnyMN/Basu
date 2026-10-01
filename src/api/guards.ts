import type { FastifyReply, FastifyRequest } from 'fastify';
import { known, type Grants } from '../platform/access/index.js';
import { forbidden } from './errors.js';

/**
 * The one check every business and desk route makes after it knows who is
 * calling: does this seat hold the permission. Who is calling — a desk
 * member or a person at a business — is the route's own
 * guard's to settle; it leaves what that seat may do in `request.grants`,
 * and this reads it. A route that forgot to settle it opens to nobody.
 *
 * A route names a permission the code knows, or the server does not start:
 * a typo here would be a door nobody could ever open, found by a person
 * rather than by a test.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** What the seat behind this request may do, from `platform/access`. */
    grants?: Grants;
  }
}

export type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function checked(permissions: string[]): void {
  for (const p of permissions) if (!known(p)) throw new Error(`a route names a permission the code does not have: ${p}`);
}

/** The seat must hold this permission. */
export const need = (permission: string): Guard => {
  checked([permission]);
  return async (request, reply) => {
    if (!request.grants?.has(permission)) return forbidden(reply, `this needs ${permission}`);
    return undefined;
  };
};

/** The seat must hold one of these — a list two pages both read from. */
export const needAny = (...permissions: string[]): Guard => {
  checked(permissions);
  return async (request, reply) => {
    if (!permissions.some((p) => request.grants?.has(p))) return forbidden(reply, `this needs one of ${permissions.join(', ')}`);
    return undefined;
  };
};

/** Whether this request's seat holds a permission — for what a route leaves out of an answer rather than refuses. */
export const holds = (request: FastifyRequest, permission: string): boolean => Boolean(request.grants?.has(permission));

/** An id as the database writes one. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `:id` in an address, looked at before anything reads it. One that is
 * not an id at all is no such thing, and is answered as the route answers
 * an id nobody has (`missing`) — never handed on to Postgres, which fails
 * the query: a 500, «Алдаа гарлаа», for a link with a typo in it. A route
 * takes it after its own guard, so a stranger is still asked who they are
 * first; a route without an `:id` passes straight through.
 */
export const knownId = (missing: (reply: FastifyReply) => FastifyReply): Guard => {
  return async (request, reply) => {
    const id = (request.params as { id?: unknown } | undefined)?.id;
    if (id === undefined || (typeof id === 'string' && UUID.test(id))) return undefined;
    return missing(reply);
  };
};
