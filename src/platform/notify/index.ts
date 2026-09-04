/**
 * Everything another module may use. Nothing else in `notify/` is public.
 *
 * Callers name a guest and a subject; they never name a channel ladder, a
 * device or a template table. That is what makes "add email" or "add Viber" a
 * change inside this directory.
 */
export {
  ack,
  dismiss,
  enqueue,
  inbox,
  markRead,
  preferences,
  relay,
  setPreferences,
  unreadCount,
  type InboxItem,
  type OutgoingRequest,
  type Preferences,
} from './messages.js';

export {
  activityTokensFor,
  devicesOf,
  registerActivityToken,
  registerDevice,
  revokeDevice,
  type Device,
} from './devices.js';
