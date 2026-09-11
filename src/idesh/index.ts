/**
 * Everything another module may use. Nothing else in `idesh/` is public.
 *
 * The rule is the platform's: no query outside this directory may name a
 * table in the `idesh` schema, and the HTTP layer reaches the vertical only
 * through here. When идэш becomes its own service, these signatures are the
 * API and the callers do not change.
 */
export { IdeshError, type IdeshErrorCode } from './errors.js';

export { recordAudit, listAudit, type AuditEntry, type AuditTarget } from './audit.js';

export {
  IDESH_STATES,
  LIVE_STATES,
  BOARD_STATES,
  canTransition,
  nextStates,
  isCommitted,
  isLive,
  type IdeshState,
} from './states.js';

export { quote, dayOf, type Offer, type Want, type Quote, type Receive, type Unit } from './pricing.js';

export {
  CANCEL_REASONS,
  REASON_LABEL,
  FORFEIT_PCT,
  NO_SHOW_DAYS,
  DEFAULT_COMMISSION_PCT,
  splitRefund,
  commissionOf,
  noShowFrom,
  reasonProblem,
  isSupplierFault,
  type CancelReason,
  type SupplierReason,
  type Split,
} from './money.js';

export {
  setRefundAccount,
  listSettlements,
  settlementsOfOrder,
  settlementsOf,
  refundOf,
  markSettled,
  type Settlement,
  type SettlementKind,
  type SettlementState,
  type BankAccount,
} from './settlements.js';

export {
  KINDS,
  UNITS,
  openListings,
  listingById,
  listingsOf,
  createListing,
  updateListing,
  hideListing,
  type Kind,
  type Listing,
  type ListingInput,
  type ListingPatch,
} from './listings.js';

export {
  registerSupplier,
  applySupplier,
  applicationOf,
  approveSupplier,
  declineSupplier,
  listSuppliers,
  updateSupplier,
  ownerOf,
  supplierOf,
  supplierById,
  updateSupplierProfile,
  setSupplierActive,
  createSupplierCode,
  pairSupplier,
  resolveSupplierDevice,
  revokeSupplierDevice,
  unpairedCodes,
  type SupplierInput,
  type SupplierPatch,
  type ProfileEdit,
  type BankDetails,
  type ApplicationInput,
  type Application,
  type SupplierState,
  type SupplierRow,
  type SupplierSession,
  type SupplierDevice,
} from './suppliers.js';

export {
  createIdesh,
  payIdesh,
  cancelIdesh,
  startPreparing,
  markReady,
  markDispatched,
  markHanded,
  housekeeping,
  liveFor,
  detailFor,
  boardFor,
  homeOf,
  ordersOf,
  allOrders,
  orderForSupplier,
  orderForOps,
  resendForOps,
  statsFor,
  ownedByGuest,
  ownedBySupplier,
  dayLabel,
  type CreateIdeshInput,
  type CreatedIdesh,
  type CancelledBy,
  type IdeshSummary,
  type IdeshDetail,
  type Board,
  type BoardTicket,
  type SupplierHome,
  type OrderFilter,
  type OpsStats,
  type Tally,
  type SupplierTally,
  type SupplierOrder,
  type OrderScope,
  type OrderEvent,
} from './orders.js';
