/**
 * Everything another module may use of organisations. Nothing else in
 * `org/` is public, and no query outside this directory names a table in
 * the `org` schema. What a role may do is `platform/access`'s to say.
 */
export {
  OrgError,
  accessIn,
  addMember,
  approveOrg,
  declineOrg,
  listOrgs,
  logOf,
  membersOf,
  noteRolesChanged,
  orgById,
  orgForExisting,
  orgsOf,
  registerOrg,
  removeMember,
  roleCounts,
  roleIn,
  seatsOf,
  setRole,
  updateOrg,
  type LogAction,
  type LogEntry,
  type Membership,
  type OrgInput,
  type OrgRole,
  type OrgState,
  type Organization,
} from './organizations.js';
