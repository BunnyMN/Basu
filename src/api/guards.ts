import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Grants, Permission } from '../platform/access/index.js';
import { forbidden } from './errors.js';

/**
 * The one check every business and desk route makes after it knows who is
 * calling: does this seat hold the permission. Who is calling — a desk
 * member, a person at a business, a paired screen — is the route's own
 * guard's to settle; it leaves what that seat may do in `request.grants`,
 * and this reads it. A route that forgot to settle it opens to nobody.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** What the seat behind this request may do, from `platform/access`. */
    grants?: Grants;
  }
}

export type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export const need =
  (permission: Permission): Guard =>
  async (request, reply) => {
    if (!request.grants?.has(permission)) return forbidden(reply, `this needs ${permission}`);
    return undefined;
  };

/** Whether this request's seat holds a permission — for what a route leaves out of an answer rather than refuses. */
export const holds = (request: FastifyRequest, permission: Permission): boolean => Boolean(request.grants?.has(permission));
