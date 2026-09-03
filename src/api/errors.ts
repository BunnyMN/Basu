import type { FastifyReply } from 'fastify';
import { AuthError } from '../platform/identity/index.js';
import { LedgerError } from '../platform/ledger/index.js';
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

const AUTH_ERRORS: Record<AuthError['code'], Spec> = {
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

export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof LedgerError) {
    const spec = LEDGER_ERRORS[error.code];
    return reply.status(spec.status).send(envelope(error.code, spec.mn, error.message));
  }
  if (error instanceof OrderError) {
    const spec = ORDER_ERRORS[error.code];
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

export function forbidden(reply: FastifyReply, what: string): FastifyReply {
  return reply
    .status(403)
    .send(envelope('FORBIDDEN', 'Танд энэ үйлдлийг хийх эрх алга.', what));
}

export function badRequest(reply: FastifyReply, mn: string, en: string): FastifyReply {
  return reply.status(400).send(envelope('BAD_REQUEST', mn, en));
}
