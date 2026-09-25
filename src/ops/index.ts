/**
 * Everything another module may use of the desk. Nothing else in `ops/` is
 * public, and no query outside this directory names a table in the `ops`
 * schema.
 */
export {
  ROLES,
  listMembers,
  memberForAccount,
  linkByProof,
  linkByInvite,
  upsertMember,
  setMemberActive,
  syncMembersFromEnv,
  type Member,
  type Role,
} from './members.js';

export { recordTick, lastTicks, pulse, type Tick, type Pulse } from './ticks.js';
export { SETTINGS, SettingError, settings, setting, setSetting, type Setting, type SettingSpec } from './settings.js';
export { InviteError, createInvite, takeInvite, releaseInvite, openInvites, type Invite } from './invites.js';
export {
  RequestError,
  requestAccess,
  requestOf,
  pendingRequests,
  approveRequest,
  declineRequest,
  type AccessRequest,
  type RequestState,
} from './requests.js';
