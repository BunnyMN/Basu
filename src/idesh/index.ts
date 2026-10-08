/**
 * Everything another module may use. Nothing else in `idesh/` is public.
 *
 * The rule is the platform's: no query outside this directory may name a
 * table in the `idesh` schema, and the HTTP layer reaches the vertical only
 * through here. When идэш becomes its own service, these signatures are the
 * API and the callers do not change.
 */
export { IdeshError, type IdeshErrorCode } from './errors.js';

export { recordAudit, listAudit, type AuditActor, type AuditEntry, type AuditLine, type AuditTarget } from './audit.js';

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
  STYLES,
  PARTS,
  STYLE_LABEL,
  STYLE_HINT,
  PART_LABEL,
  NOTE_MAX,
  describe,
  type Breakdown,
  type BreakdownOffer,
  type BreakdownWant,
  type Part,
  type Style,
} from './breakdown.js';

export {
  CANCEL_REASONS,
  REASON_LABEL,
  FORFEIT_PCT,
  NO_SHOW_DAYS,
  DEFAULT_COMMISSION_PCT,
  splitRefund,
  commissionOf,
  meatOf,
  noShowFrom,
  reasonProblem,
  isSupplierFault,
  type CancelReason,
  type SupplierReason,
  type Split,
} from './money.js';

export {
  setRefundAccount,
  approveSettlement,
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
  TIERS,
  type Tier,
} from './listings.js';

export {
  addCertificate,
  updateCertificate,
  AIMAGS,
  certificatesOf,
  certificateById,
  certificatesForDesk,
  certificatePhoto,
  removeCertificate,
  checkCertificate,
  photoType,
  MAX_PHOTO_BYTES,
  type Certificate,
  type CertificateFacts,
  type CertificateInput,
  type CertificateDetails,
  type CertificateProduct,
  type CertificateTest,
  type CertificatePhoto,
  type CertificateState,
  type DeskCertificate,
} from './certificates.js';

export {
  startPromotion,
  settlePromotion,
  promotionsOf,
  promotionsForDesk,
  endPromotion,
  type DeskPromotion,
  TIER_WORD,
  type Plan,
  type Promotion,
  type Started,
} from './promotions.js';

export {
  registerSupplier,
  supplierForOrg,
  openSupplierOf,
  type SupplierRole,
  applySupplier,
  applicationOf,
  approveSupplier,
  declineSupplier,
  listSuppliers,
  updateSupplier,
  ownerOf,
  supplierOf,
  supplierOfOrg,
  supplierById,
  updateSupplierProfile,
  setSupplierActive,
  bankWouldChange,
  verifySupplierBank,
  type SupplierInput,
  type SupplierPatch,
  type ProfileEdit,
  type BankDetails,
  type ApplicationInput,
  type Application,
  type SupplierState,
  type SupplierRow,
} from './suppliers.js';

export {
  createIdesh,
  payIdesh,
  cancelIdesh,
  startPreparing,
  markReady,
  certifyIdesh,
  markDispatched,
  markHanded,
  housekeeping,
  finishInvoiceFor,
  type PayOutcome,
  liveFor,
  ownsIdesh,
  ideshCardFacts,
  ideshCardsToStart,
  stepMessage,
  STEP_WORD,
  type IdeshCardStart,
  allFor,
  detailFor,
  boardFor,
  homeOf,
  ordersOf,
  allOrders,
  guestsByDeliveryPhone,
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

export {
  MAX_LISTING_PHOTOS,
  MAX_THUMB_BYTES,
  addListingPhoto,
  removeListingPhoto,
  orderListingPhotos,
  listingPhoto,
  type Picture,
} from './photos.js';

export { callTermsFor, CALL_DAYS_AFTER_HANDOVER, type CallTerms } from './calls.js';
