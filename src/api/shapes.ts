import type { QPayInvoice } from '../ports.js';
import { describe, type Breakdown, type CertificateDetails, type CertificateFacts, type IdeshSummary, type Settlement, type SupplierOrder } from '../idesh/index.js';

/** The JSON shapes the idesh and ops routes share. Snake case on the wire, as everywhere. */

/**
 * The certificate on a listing or an order, as a guest reads it: which one,
 * from whom, where the animals came from, what the laboratory did not find,
 * and whether Basu looked it up.
 */
export const shapeCertificateFacts = (c: CertificateFacts | null) =>
  c ? { number: c.number, issuer: c.issuer, issued_on: c.issuedOn, checked: c.checked, origin: c.origin, tests: c.tests } : null;

/** The paper's details, for the supplier who wrote them and the desk — never a guest. */
export const shapeCertificateDetails = (c: CertificateDetails) => ({
  valid_until: c.validUntil,
  inspector: c.inspector,
  origin: c.origin,
  herder: c.herder,
  route: c.route,
  products: c.products,
  tests: c.tests.map((t) => ({ disease: t.disease, tested_on: t.testedOn, lab: t.lab })),
  qr: c.qr,
});

/**
 * Задаргаа on an order: what was chosen, and the same in words — one wording
 * for the guest's page, the supplier's ticket and the desk.
 */
export const shapeBreakdown = (b: Breakdown | null, feeMnt: number) =>
  b ? { style: b.style, cut: b.cut, note: b.note, fee_mnt: feeMnt, ...describe(b) } : null;

/**
 * A listing's own photograph as a page asks for it: as it is looked at, and
 * small for a card. The address never changes what it serves, so it is kept.
 */
export const shapePhoto = (id: string) => ({ id, url: `/v1/idesh/photos/${id}`, thumb: `/v1/idesh/photos/${id}?size=thumb` });

export const shapeSummary = (o: IdeshSummary) => ({
  id: o.id,
  code: o.code,
  state: o.state,
  supplier: o.supplier,
  kind: o.kind,
  unit: o.unit,
  title: o.title,
  qty: o.qty,
  total_mnt: o.totalMnt,
  receive: o.receive,
  receive_on: o.receiveOn,
  paid_at: o.paidAt?.toISOString() ?? null,
  // Only a pickup has somewhere to go; a delivery's address is the guest's own.
  pickup_address: o.receive === 'pickup' ? (o.pickupAddress ?? null) : null,
  certificate: shapeCertificateFacts(o.certificate),
  breakdown: shapeBreakdown(o.breakdown, o.cutFeeMnt),
  photo: o.photo,
  // The listing's own cover while it has one; null, and the page draws the example `photo` names.
  cover: o.cover ? shapePhoto(o.cover) : null,
});

/** An order as the supplier's screens and the ops desk read it. */
export const shapeOrder = (o: SupplierOrder) => ({
  ...shapeSummary(o),
  guest: o.guest,
  guest_phone: o.guestPhone,
  address: o.address,
  address_phone: o.addressPhone,
  address_lat: o.addressLat,
  address_lon: o.addressLon,
  delivery_fee_mnt: o.deliveryFeeMnt,
  ready_at: o.readyAt?.toISOString() ?? null,
  handed_at: o.handedAt?.toISOString() ?? null,
  cancelled_at: o.cancelledAt?.toISOString() ?? null,
  cancel_reason: o.cancelReason,
  refund_mnt: o.refundMnt,
  forfeit_mnt: o.forfeitMnt,
  no_show_from: o.noShowFrom?.toISOString() ?? null,
  payout_mnt: o.payoutMnt,
  created_at: o.createdAt.toISOString(),
});

/** A settlement as the ops page and the supplier's screen read it. */
export const shapeSettlement = (t: Settlement) => ({
  id: t.id,
  kind: t.kind,
  state: t.state,
  memo: t.memo,
  order_id: t.orderId,
  order_code: t.orderCode,
  amount_mnt: t.amountMnt,
  supplier: t.supplier,
  guest: t.guest,
  bank_name: t.bank?.bankName ?? null,
  bank_account: t.bank?.bankAccount ?? null,
  bank_holder: t.bank?.bankHolder ?? null,
  bank_verified: t.bankVerified,
  reference: t.reference,
  approved_by: t.approvedBy,
  approved_at: t.approvedAt?.toISOString() ?? null,
  paid_at: t.paidAt?.toISOString() ?? null,
  created_at: t.createdAt.toISOString(),
});

/**
 * A QPay invoice the app draws itself: the QR's text (the app makes the
 * picture), every bank app with its logo and the link that opens it on this
 * invoice, and when it lapses unpaid.
 */
export function shapeQpay(qpay: QPayInvoice) {
  return {
    qr: qpay.qr,
    banks: qpay.banks.map((bank) => ({ name: bank.name, description: bank.description, logo: bank.logo, link: bank.link })),
    expires_at: qpay.expiresAt?.toISOString() ?? null,
  };
}
