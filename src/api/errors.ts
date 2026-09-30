import type { FastifyReply } from 'fastify';
import { AuthError, FRESH_SIGN_IN_MINUTES, PasswordError } from '../platform/identity/index.js';
import { LedgerError } from '../platform/ledger/index.js';
import { ClosureError } from '../platform/identity/index.js';
import { IdeshError, type IdeshErrorCode } from '../idesh/index.js';
import { MemberError } from '../ops/index.js';
import { OrderError, type OrderErrorCode } from '../services/orders.js';

/**
 * One error envelope, and the Mongolian text is part of it.
 *
 * The client shows `message_mn` verbatim. Putting the wording here rather than
 * in the PWA means a copy fix ships without a client release, and it stops the
 * same condition being explained three different ways in three places.
 */

export interface ErrorBody {
  error: {
    code: string;
    message_mn: string;
    message_en: string;
    retry_after?: number;
  };
}

type Spec = { status: number; mn: string };

const ORDER_ERRORS: Record<OrderErrorCode, Spec> = {
  SLOT_FULL: {
    status: 409,
    mn: 'Энэ цаг дүүрсэн байна. Ойролцоох цагаас сонгоно уу.',
  },
  NO_TABLE: {
    status: 409,
    mn: 'Энэ цагт сул ширээ алга байна. Өөр цаг сонгоно уу.',
  },
  ITEM_SOLD_OUT: {
    status: 409,
    mn: 'Энэ хоол өнөөдөр дууссан байна.',
  },
  TOO_LATE_TO_CANCEL: {
    status: 409,
    // The guest is not being refused arbitrarily — say what changed.
    mn: 'Таны хоол аль хэдийн гал дээр гарсан тул цуцлах боломжгүй.',
  },
  TRUST_BLOCKED: {
    status: 403,
    mn: 'Дараалсан хоёр удаа ирээгүй тул урьдчилсан захиалга түр хаагдсан байна.',
  },
  WRONG_STATE: {
    status: 409,
    mn: 'Захиалгын төлөв өөрчлөгдсөн байна. Дэлгэцээ шинэчилнэ үү.',
  },
  NOT_FOUND: {
    status: 404,
    mn: 'Ийм захиалга олдсонгүй.',
  },
  PAYMENT_FAILED: {
    status: 402,
    mn: 'Төлбөр амжилтгүй боллоо. Дахин оролдоно уу.',
  },
};

const IDESH_ERRORS: Record<IdeshErrorCode, Spec> = {
  NOT_FOUND: { status: 404, mn: 'Ийм идэш олдсонгүй.' },
  WRONG_STATE: {
    status: 409,
    mn: 'Идэшний төлөв өөрчлөгдсөн байна. Дэлгэцээ шинэчилнэ үү.',
  },
  SOLD_OUT: { status: 409, mn: 'Энэ зар дууссан байна. Өөр зар сонгоно уу.' },
  TOO_FEW: { status: 400, mn: 'Захиалах тоо хамгийн бага хэмжээнээс бага байна.' },
  NO_DELIVERY: { status: 400, mn: 'Энэ нийлүүлэгч хүргэлт хийдэггүй. Өөрөө очиж авна уу.' },
  NO_ADDRESS: { status: 400, mn: 'Хүргүүлэх хаяг, залгах утсаа оруулна уу.' },
  BAD_DATE: { status: 400, mn: 'Энэ өдөр мах бэлэн болоогүй байна. Өөр өдөр сонгоно уу.' },
  PAYMENT_FAILED: { status: 402, mn: 'Төлбөр амжилтгүй боллоо. Дахин оролдоно уу.' },
  BAD_REASON: { status: 409, mn: 'Энэ шалтгаанаар одоо цуцлах боломжгүй.' },
  NEEDS_ACCOUNT: { status: 409, mn: 'Шилжүүлэх данс оруулаагүй байна.' },
  OTP_REQUIRED: { status: 409, mn: 'Баталгаажуулах код утсанд тань илгээлээ. Кодоо оруулна уу.' },
  PASSWORD_REQUIRED: { status: 409, mn: 'Нууц үгээ оруулж баталгаажуулна уу.' },
  BAD_PASSWORD: { status: 401, mn: 'Нууц үг буруу байна.' },
  BANK_UNVERIFIED: { status: 409, mn: 'Данс баталгаажаагүй байна. Санхүү гэрээтэй тулгаж баталгаажуулна.' },
  NOT_APPROVED: { status: 409, mn: 'Эхлээд өөр гишүүн олголтыг батална. Дараа нь шилжүүлсэн гэж тэмдэглэнэ.' },
  SAME_PERSON: { status: 409, mn: 'Баталсан хүн өөрөө шилжүүлж болохгүй. Өөр гишүүн тэмдэглэнэ.' },
  ALREADY_APPLIED: {
    status: 409,
    mn: 'Та аль хэдийн хүсэлт гаргасан эсвэл нийлүүлэгч байна.',
  },
  NOT_PENDING: { status: 409, mn: 'Энэ хүсэлт хүлээгдэж байгаа төлөвт биш байна.' },
  NEEDS_PHONE: { status: 400, mn: 'Холбогдох утасны дугаараа оруулна уу.' },
  OPS_CLOSED: {
    status: 503,
    mn: 'Ops хаалттай байна: сервер дээр OPS_TOKEN тохируулаагүй.',
  },
  NOT_PROMOTABLE: {
    status: 409,
    mn: 'Энэ зарыг онцлох боломжгүй: зар зогссон, дууссан, эсвэл аль хэдийн VIP байна.',
  },
};

const PASSWORD_ERRORS: Record<PasswordError['code'], Spec> = {
  TOO_SHORT: { status: 400, mn: 'Нууц үг дор хаяж 8 тэмдэгт байх ёстой.' },
  TOO_LONG: { status: 400, mn: 'Нууц үг хэт урт байна.' },
};

const AUTH_ERRORS: Record<AuthError['code'], Spec> = {
  BAD_EMAIL: { status: 400, mn: 'Имэйл хаягаа шалгана уу.' },
  NO_EMAIL: {
    status: 404,
    mn: 'Энэ дугаарт имэйл холбогдоогүй тул код илгээх боломжгүй. Имэйл хаягаараа оролдох, эсвэл basuappmn@gmail.com руу бичнэ үү.',
  },
  EMAIL_TAKEN: { status: 409, mn: 'Энэ имэйл өөр бүртгэлд холбогдсон байна.' },
  EMAIL_SET: { status: 409, mn: 'Таны бүртгэлд имэйл аль хэдийн холбогдсон байна.' },
  WRONG_PASSWORD: { status: 403, mn: 'Одоогийн нууц үг буруу байна.' },
  // A session alone proves nothing about who holds it; these say what will.
  PROOF_REQUIRED: {
    status: 403,
    // Only an app from before the code asks without one: iOS 1.0.3 sends an
    // empty `current` from «Нууц үг тохируулах», has no field for a code, and
    // shows these words as they are. So they say what is needed now, why
    // that app cannot give it, and the way that can today: the website. The
    // app that asks for the code is the next one, not yet in the App Store.
    mn: 'Нууц үг тохируулахад бүртгэлийн тань имэйл рүү очих код хэрэгтэй болсон, харин аппын энэ хувилбар кодыг асуудаггүй. Одоохондоо Basu-гийн вэб сайтын «Бүртгэл» хуудаснаас тохируулна уу — аппын дараагийн хувилбарт эндээс ч болно.',
  },
  PASSWORD_SET: { status: 409, mn: 'Таны бүртгэлд нууц үг аль хэдийн тохируулсан байна. Одоогийн нууц үгээрээ солино уу.' },
  SIGN_IN_AGAIN: {
    status: 403,
    mn: `Таныг мөн гэдгийг батлахын тулд гараад дахин нэвтэрнэ үү. Дараа нь ${FRESH_SIGN_IN_MINUTES} минутын дотор имэйлээ холбоно уу.`,
  },
  EMAIL_CLOSED: { status: 503, mn: 'Имэйлээр нэвтрэх түр ажиллахгүй байна. Өөр аргаар нэвтэрнэ үү.' },
  EMAIL_FAILED: { status: 502, mn: 'Код илгээж чадсангүй. Хэсэг хүлээгээд дахин оролдоно уу.' },
  SMS_CLOSED: { status: 503, mn: 'SMS кодоор нэвтрэх түр ажиллахгүй байна. Өөр аргаар нэвтэрнэ үү.' },
  SOCIAL_CLOSED: { status: 503, mn: 'Энэ аргаар нэвтрэх түр ажиллахгүй байна.' },
  SOCIAL_REFUSED: { status: 401, mn: 'Нэвтрэлт баталгаажсангүй. Дахин оролдоно уу.' },
  // One answer for a code never made, spent, late or brought without its
  // cookie: which of them it was is nothing a stranger with a code should learn.
  HANDOFF_REFUSED: { status: 400, mn: 'Google-ээр нэвтрэлт хүчингүй болсон байна. Дахин нэвтэрнэ үү.' },
  BAD_PHONE: { status: 400, mn: 'Утасны дугаараа шалгана уу (+976XXXXXXXX).' },
  PHONE_TAKEN: { status: 409, mn: 'Энэ дугаар аль хэдийн бүртгэлтэй. Нэвтэрнэ үү.' },
  BAD_CREDENTIALS: { status: 401, mn: 'Имэйл/утас эсвэл нууц үг буруу байна.' },
  LOCKED: { status: 429, mn: 'Нууц үг хэд хэдэн удаа буруу орлоо. 15 минутын дараа дахин оролдоно уу.' },
  RATE_LIMITED: {
    status: 429,
    mn: 'Хэт олон удаа оролдлоо. Хэсэг хүлээгээд дахин оролдоно уу.',
  },
  INVALID_CODE: { status: 400, mn: 'Код буруу байна.' },
  EXPIRED: { status: 410, mn: 'Кодын хугацаа дууссан. Шинэ код авна уу.' },
  UNAUTHORIZED: { status: 401, mn: 'Нэвтэрч орно уу.' },
};

const LEDGER_ERRORS: Record<LedgerError['code'], Spec> = {
  INSUFFICIENT_FUNDS: {
    status: 402,
    // Says what to do about it, because there is something to do about it.
    mn: 'Түрийвчинд хүрэлцэхгүй байна. Цэнэглээд дахин оролдоно уу.',
  },
  PAYMENTS_CLOSED: { status: 503, mn: 'Төлбөр одоогоор хаалттай байна. Удахгүй нээгдэнэ.' },
  NOT_PAID_YET: { status: 409, mn: 'Төлбөр хараахан хийгдээгүй байна. Төлсний дараа дахин шалгана уу.' },
  TOPUP_FAILED: {
    status: 402,
    mn: 'Цэнэглэлт амжилтгүй боллоо. Дахин оролдоно уу.',
  },
  PAYMENT_FAILED: {
    status: 402,
    mn: 'Төлбөр амжилтгүй боллоо. Дахин оролдоно уу.',
  },
  NOT_FOUND: { status: 404, mn: 'Ийм гүйлгээ олдсонгүй.' },
};

/** Who sits at the desk: the admin reading these is changing somebody's seat. */
const MEMBER_ERRORS: Record<MemberError['code'], Spec> = {
  NOT_FOUND: { status: 404, mn: 'Ийм гишүүн олдсонгүй.' },
  NO_ROLE: { status: 400, mn: 'Эрх буруу байна.' },
  LAST_ADMIN: { status: 409, mn: 'Ядаж нэг идэвхтэй админ үлдэх ёстой.' },
  ALREADY_SEATED: {
    status: 409,
    // Says where the change is made instead: the seat is there, its role is changed in the table.
    mn: 'Энэ хэрэглэгч ops-ийн гишүүн байна. Эрхийг нь «Гишүүд» хүснэгтээс «Эрх солих» товчоор солино уу.',
  },
  OWN_SEAT: { status: 400, mn: 'Өөрийн эрхийг өөрчлөх боломжгүй.' },
  FORBIDDEN: { status: 403, mn: 'Танд энэ үйлдлийг хийх эрх алга.' },
  AT_THE_DESK: {
    status: 409,
    // Says where it is done instead: the seat goes off on the members page, under that page's rules.
    mn: 'Энэ хэрэглэгч ops-ийн идэвхтэй гишүүн байна. Бүртгэлийг нь хаахаас өмнө «Гишүүд» хуудсанд гишүүнийг хаана уу.',
  },
};

const CLOSURE_ERRORS: Record<ClosureError['code'], Spec> = {
  HAS_BALANCE: {
    status: 409,
    // Says what to do about it. Somebody leaving is not somebody who wants to
    // leave their money behind.
    mn: 'Түрийвчинд мөнгө байна. Зарцуулах эсвэл буцаан авсны дараа хаах боломжтой.',
  },
  HAS_LIVE_WORK: {
    status: 409,
    mn: 'Явж байгаа захиалга байна. Дуусахыг хүлээгээд дахин оролдоно уу.',
  },
};

export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ClosureError) {
    const spec = CLOSURE_ERRORS[error.code];
    return reply.status(spec.status).send(envelope(error.code, spec.mn, error.message));
  }
  if (error instanceof LedgerError) {
    const spec = LEDGER_ERRORS[error.code];
    return reply.status(spec.status).send(envelope(error.code, spec.mn, error.message));
  }
  if (error instanceof OrderError) {
    const spec = ORDER_ERRORS[error.code];
    return reply.status(spec.status).send(envelope(error.code, spec.mn, error.message));
  }
  if (error instanceof MemberError) {
    const spec = MEMBER_ERRORS[error.code];
    return reply.status(spec.status).send(envelope(error.code, spec.mn, error.message));
  }
  if (error instanceof IdeshError) {
    const spec = IDESH_ERRORS[error.code];
    // A refused cancel reason says why in Mongolian — the supplier is reading.
    const mn = error.code === 'BAD_REASON' ? `${spec.mn.replace(/\.$/, '')}: ${error.message}.` : spec.mn;
    return reply.status(spec.status).send(envelope(error.code, mn, error.message));
  }
  // A password that is too short is the person's typing, not our fault, and
  // must read as such rather than as «Алдаа гарлаа».
  if (error instanceof PasswordError) {
    const spec = PASSWORD_ERRORS[error.code];
    return reply.status(spec.status).send(envelope(error.code, spec.mn, error.message));
  }

  if (error instanceof AuthError) {
    const spec = AUTH_ERRORS[error.code];
    const body = envelope(error.code, spec.mn, error.message);
    if (error.code === 'RATE_LIMITED') body.error.retry_after = 3600;
    return reply.status(spec.status).send(body);
  }

  reply.log.error({ err: error }, 'unhandled request failure');
  return reply
    .status(500)
    .send(envelope('INTERNAL', 'Алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.', 'internal error'));
}

function envelope(code: string, mn: string, en: string): ErrorBody {
  return { error: { code, message_mn: mn, message_en: en } };
}

export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .status(401)
    .send(envelope('UNAUTHORIZED', 'Нэвтэрч орно уу.', 'authentication required'));
}

/**
 * Signed in, but too long ago for Basu's desk. The session still opens the
 * website and the app; the desk asks for a sign-in of its own, and the
 * dashboard shows its door with these words. `mn` is for the account's own
 * pages, which ask the same of a desk member before a way in is changed and
 * say it in words of their own.
 */
export function signInAgain(reply: FastifyReply, mn = 'Аюулгүй байдлын үүднээс ops-д дахин нэвтэрнэ үү.'): FastifyReply {
  return reply.status(401).send(envelope('SIGN_IN_AGAIN', mn, 'the desk needs a recent sign-in'));
}

export function forbidden(reply: FastifyReply, what: string): FastifyReply {
  return reply
    .status(403)
    .send(envelope('FORBIDDEN', 'Танд энэ үйлдлийг хийх эрх алга.', what));
}

export function badRequest(reply: FastifyReply, mn: string, en: string): FastifyReply {
  return reply.status(400).send(envelope('BAD_REQUEST', mn, en));
}

/**
 * NO_EMAIL, said inside the account. At the door somebody typed a number
 * with no address behind it, and is told to try their address or write to
 * Basu; inside, nobody typed anything, and the account is told what to do
 * first — the code for a first password goes to an address it has not got.
 */
export function addEmailFirst(reply: FastifyReply): FastifyReply {
  return reply
    .status(AUTH_ERRORS.NO_EMAIL.status)
    .send(envelope('NO_EMAIL', 'Эхлээд имэйлээ холбоно уу — нууц үг тохируулах код тэр хаяг руу очно.', 'no address stands behind this account'));
}
