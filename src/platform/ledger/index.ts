/**
 * Everything another module may use. Nothing else in `ledger/` is public.
 *
 * A vertical asks to be paid and asks for a receipt. It never learns whether
 * the money came out of a balance or off a card, and it never sees an account
 * or an entry — which is why adding a second payment provider, or a promotion
 * that pays part of a bill, is a change that stops at this directory's edge.
 */
export {
  LedgerError,
  balance,
  collect,
  reconcileLedger,
  refund,
  settleTopup,
  startTopup,
  wallet,
  type Collected,
  type CollectInput,
  type StatementLine,
  type TopupStarted,
  type Wallet,
} from './wallet.js';

export {
  processReceipts,
  queueReceipt,
  receiptsFor,
  reconcile,
  type IssuedReceipt,
} from './ebarimt.js';
