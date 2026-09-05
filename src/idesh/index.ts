/**
 * Everything another module may use. Nothing else in `idesh/` is public.
 *
 * The rule is the platform's: no query outside this directory may name a
 * table in the `idesh` schema, and the HTTP layer reaches the vertical only
 * through here. When идэш becomes its own service, these signatures are the
 * API and the callers do not change.
 */
export { IdeshError, type IdeshErrorCode } from './errors.js';

export {
  IDESH_STATES,
  LIVE_STATES,
  BOARD_STATES,
  canTransition,
  nextStates,
  isFreeToCancel,
  isCommitted,
  isLive,
  type IdeshState,
} from './states.js';

export { quote, dayOf, type Offer, type Want, type Quote, type Receive, type Unit } from './pricing.js';

export {
  KINDS,
  UNITS,
  openListings,
  listingById,
  listingsOf,
  createListing,
  updateListing,
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
  createSupplierCode,
  pairSupplier,
  resolveSupplierDevice,
  revokeSupplierDevice,
  unpairedCodes,
  type SupplierInput,
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
} from './orders.js';
