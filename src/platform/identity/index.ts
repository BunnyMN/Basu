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
  OTP_PER_DAY,
  purgeChallenges,
  verifyOtp,
  checkOtp,
  sendOtp,
  startSession,
  guestForPhone,
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

export { guestCensus, type GuestCensus } from './census.js';
export { findGuests, guestCard, type GuestCard } from './directory.js';

export { MIN_PASSWORD, PasswordError, checkPassword, hashPassword, verifyPassword } from './password.js';
export { registerGuest, signInWithPassword, claimAccount, changePassword, confirmPassword, hasPassword, phoneE164 } from './register.js';
