/**
 * Everything another module may use of access. It keeps no tables: who is a
 * member of what lives with the desk and with the organisations; what that
 * membership lets a person do lives here, once.
 */
export {
  DESK_ROLES,
  DESK_ROLE_WORD,
  MODULE_WORD,
  NO_GRANTS,
  ORG_ROLES,
  ORG_ROLE_WORD,
  PERMISSIONS,
  catalogue,
  deskGrants,
  deskRoleHas,
  mayAssign,
  modulesOf,
  orgGrants,
  orgRoleHas,
  type DeskRole,
  type Grants,
  type OrgModule,
  type OrgRole,
  type Permission,
} from './policy.js';

export { deskMenu, meMenu, orgMenu, pagesOf, type MenuGroup, type MenuItem } from './menu.js';
