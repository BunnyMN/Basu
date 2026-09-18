/**
 * Everything another module may use of the desk. Nothing else in `ops/` is
 * public, and no query outside this directory names a table in the `ops`
 * schema.
 */
export {
  ROLES,
  listMembers,
  memberByPhone,
  upsertMember,
  setMemberActive,
  syncMembersFromEnv,
  type Member,
  type Role,
} from './members.js';

export { recordTick, lastTicks, pulse, type Tick, type Pulse } from './ticks.js';
export { SETTINGS, SettingError, settings, setting, setSetting, type Setting, type SettingSpec } from './settings.js';
