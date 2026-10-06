/** Codes match the API error envelope; the Mongolian text lives in src/api/errors.ts. */
export type IdeshErrorCode =
  | 'NOT_FOUND'
  | 'WRONG_STATE'
  | 'SOLD_OUT'
  | 'TOO_FEW'
  | 'NO_DELIVERY'
  | 'NO_ADDRESS'
  | 'BAD_DATE'
  | 'PAYMENT_FAILED'
  | 'BAD_REASON'
  | 'NEEDS_ACCOUNT'
  | 'OTP_REQUIRED'
  | 'PASSWORD_REQUIRED'
  | 'BAD_PASSWORD'
  | 'BANK_UNVERIFIED'
  | 'NOT_APPROVED'
  | 'SAME_PERSON'
  | 'ALREADY_APPLIED'
  | 'NEEDS_PHONE'
  | 'NOT_PENDING'
  | 'OPS_CLOSED'
  | 'NOT_PROMOTABLE'
  | 'NEEDS_CERTIFICATE'
  | 'NO_CERTIFICATE'
  | 'BAD_CERTIFICATE'
  | 'CERTIFICATE_EXISTS'
  | 'CERTIFICATE_FALSE'
  | 'CERTIFICATE_IN_USE'
  | 'BAD_BREAKDOWN'
  | 'BAD_PHOTO'
  | 'TOO_MANY_PHOTOS';

export class IdeshError extends Error {
  constructor(
    readonly code: IdeshErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdeshError';
  }
}
