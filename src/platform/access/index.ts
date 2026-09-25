/**
 * Everything another module may use of access: the pages the code can draw
 * and the actions on them, the roles Basu made, which roles each business
 * may hand out, and the menu as Basu laid it out. No query outside this
 * directory names a table in the `access` schema.
 */
export {
  BUILTIN_ROLES,
  ICONS,
  LONE_OWNER_PERMISSIONS,
  MODULES,
  PAGES,
  SCOPES,
  SCREEN_PERMISSIONS,
  TOP,
  act,
  known,
  orgCeiling,
  pageSpec,
  parse,
  permissionsOf,
  view,
  type ModuleSpec,
  type OrgKind,
  type PageSpec,
  type Scope,
} from './catalog.js';

export {
  NO_GRANTS,
  buildMenu,
  grants,
  grantsOf,
  mayHandOut,
  mayHandOutDesk,
  mayShape,
  orgGrantsOf,
  pagesOf,
  type Grants,
  type Layout,
  type LayoutModule,
  type LayoutPage,
  type MenuGroup,
  type MenuItem,
  type RoleShape,
} from './policy.js';

export {
  AccessError,
  addLink,
  addModule,
  chosenRoles,
  createRole,
  deleteRole,
  ensureRoles,
  headRoles,
  layoutOf,
  linksOf,
  removeLink,
  removeModule,
  roleOf,
  rolesForOrg,
  rolesOf,
  saveLayout,
  setChosenRoles,
  updateRole,
  type Role,
} from './store.js';
