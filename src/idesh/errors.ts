/** Codes match the API error envelope; the Mongolian text lives in src/api/errors.ts. */
export type IdeshErrorCode =
  | 'NOT_FOUND'
  | 'WRONG_STATE'
  | 'SOLD_OUT'
  | 'TOO_FEW'
  | 'NO_DELIVERY'
  | 'NO_ADDRESS'
  | 'BAD_DATE'
  | 'TOO_LATE_TO_CANCEL'
  | 'PAYMENT_FAILED'
  | 'ALREADY_APPLIED'
  | 'NOT_PENDING'
  | 'OPS_CLOSED';

export class IdeshError extends Error {
  constructor(
    readonly code: IdeshErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdeshError';
  }
}
