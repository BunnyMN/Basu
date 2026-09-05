/**
 * Everything another module may use. Nothing else in `identity/` is public.
 *
 * The rule this file exists to make obvious: no query outside this directory
 * may name a table in the `identity` schema. When identity becomes its own
 * service, this file's signatures are the API — the callers do not change.
 */
export {
  AuthError,
  OTP_PER_PHONE_PER_HOUR,
  requestOtp,
  verifyOtp,
  startSession,
  resolveGuest,
  type GuestSession,
  type OtpIssued,
} from './auth.js';

export {
  contactsFor,
  displayNamesFor,
  profileOf,
  updateProfile,
  type Contact,
  type Profile,
  type ProfileEdit,
} from './profile.js';

export {
  ClosureError,
  closeAccount,
  revokeOtherSessions,
  revokeSession,
  sessionsOf,
  type DeviceSession,
} from './sessions.js';
