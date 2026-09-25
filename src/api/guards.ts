import type { FastifyReply, FastifyRequest } from 'fastify';
import { known, type Grants } from '../platform/access/index.js';
import { forbidden } from './errors.js';

/**
 * The one check every business and desk route makes after it knows who is
 * calling: does this seat hold the permission. Who is calling — a desk
 * member, a person at a business, a paired screen — is the route's own
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
