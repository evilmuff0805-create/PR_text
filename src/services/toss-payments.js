const TOSS_API_BASE_URL = 'https://api.tosspayments.com/v1';

export class TossPaymentError extends Error {
  constructor(message, {
    status = 502,
    code = null,
    retryable = true,
    definitivelyNotCanceled = false,
  } = {}) {
    super(message);
    this.name = 'TossPaymentError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.definitivelyNotCanceled = definitivelyNotCanceled;
  }
}

function parseKey(key, expectedKind) {
  if (typeof key !== 'string') {
    throw new Error('토스페이먼츠 API 키 형식이 올바르지 않습니다.');
  }

  const match = /^(test|live)_(g?c|g?s)k_/.exec(key);
  if (!match) {
    throw new Error('토스페이먼츠 API 키 형식이 올바르지 않습니다.');
  }

  const kind = match[2].endsWith('c') ? 'client' : 'secret';
  if (kind !== expectedKind) {
    throw new Error(`토스페이먼츠 ${expectedKind === 'client' ? '클라이언트' : '시크릿'} 키가 잘못 설정되었습니다.`);
  }

  return {
    environment: match[1],
    integration: match[2].startsWith('g') ? 'checkout' : 'individual',
  };
}

export function validateTossKeyPair({ clientKey, secretKey }) {
  const client = parseKey(clientKey, 'client');
  const secret = parseKey(secretKey, 'secret');

  if (client.environment !== secret.environment) {
    throw new Error('토스페이먼츠 테스트 키와 실결제 키가 섞여 있습니다.');
  }
  if (client.integration !== secret.integration) {
    throw new Error('토스페이먼츠 결제창 키와 API 개별 연동 키가 섞여 있습니다.');
  }
  if (client.environment === 'live' && client.integration !== 'checkout') {
    throw new Error('실결제는 토스페이먼츠 주문서형·결제창형(gck/gsk) 키를 사용해야 합니다.');
  }

  return { environment: client.environment };
}

export function isVerifiedTossPayment(payment, expected) {
  return Boolean(
    payment
    && payment.paymentKey === expected.paymentKey
    && payment.orderId === expected.orderId
    && payment.totalAmount === expected.amount
    && payment.status === 'DONE'
  );
}

export function isVerifiedCanceledTossPayment(payment, expected) {
  const canceledAmount = Array.isArray(payment?.cancels)
    ? payment.cancels.reduce((sum, cancel) => sum + Number(cancel?.cancelAmount || 0), 0)
    : 0;

  return Boolean(
    payment
    && payment.paymentKey === expected.paymentKey
    && payment.orderId === expected.orderId
    && payment.totalAmount === expected.amount
    && payment.status === 'CANCELED'
    && Number(payment.balanceAmount) === 0
    && canceledAmount === expected.amount
  );
}

// 부분 취소는 잔액이 남아 있고 상태가 PARTIAL_CANCELED다. 취소된 금액을 돌려준다.
// 검증에 실패하거나 부분 취소가 아니면 0을 반환해 호출부가 처리하지 않게 한다.
export function verifiedPartialCancelAmount(payment, expected) {
  const canceledAmount = Array.isArray(payment?.cancels)
    ? payment.cancels.reduce((sum, cancel) => sum + Number(cancel?.cancelAmount || 0), 0)
    : 0;
  const balanceAmount = Number(payment?.balanceAmount);

  const verified = Boolean(
    payment
    && payment.paymentKey === expected.paymentKey
    && payment.orderId === expected.orderId
    && payment.totalAmount === expected.amount
    && payment.status === 'PARTIAL_CANCELED'
    && Number.isFinite(balanceAmount)
    && balanceAmount > 0
    && canceledAmount > 0
    && canceledAmount + balanceAmount === expected.amount
  );

  return verified ? canceledAmount : 0;
}

function createAuthorization(secretKey) {
  return `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function requestToss(url, options, fetchFn) {
  try {
    const response = await fetchFn(url, options);
    return {
      ok: response.ok,
      status: response.status,
      data: await readJson(response),
    };
  } catch (error) {
    throw new TossPaymentError('토스페이먼츠 응답을 확인하지 못했습니다.', {
      status: 502,
      code: 'TOSS_NETWORK_ERROR',
      retryable: true,
    });
  }
}

function toProviderError(result, fallbackMessage) {
  return new TossPaymentError(result.data?.message || fallbackMessage, {
    status: result.status,
    code: result.data?.code || null,
    retryable: result.status >= 500 || result.status === 408 || result.status === 429,
  });
}

export async function getTossPaymentByOrderId({
  orderId,
  secretKey,
  fetchFn = fetch,
}) {
  const result = await requestToss(
    `${TOSS_API_BASE_URL}/payments/orders/${encodeURIComponent(orderId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: createAuthorization(secretKey),
      },
    },
    fetchFn,
  );

  if (!result.ok) {
    throw toProviderError(result, '결제 상태를 조회하지 못했습니다.');
  }

  return result.data;
}

export async function confirmOrRecoverTossPayment({
  paymentKey,
  orderId,
  amount,
  idempotencyKey,
  secretKey,
  fetchFn = fetch,
}) {
  const expected = { paymentKey, orderId, amount };
  let confirmationError;

  try {
    const result = await requestToss(
      `${TOSS_API_BASE_URL}/payments/confirm`,
      {
        method: 'POST',
        headers: {
          Authorization: createAuthorization(secretKey),
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ paymentKey, orderId, amount }),
      },
      fetchFn,
    );

    if (result.ok && isVerifiedTossPayment(result.data, expected)) {
      return { payment: result.data, recovered: false };
    }

    confirmationError = result.ok
      ? new TossPaymentError('결제 승인 응답이 주문 정보와 일치하지 않습니다.', {
        status: 502,
        code: 'TOSS_CONFIRMATION_MISMATCH',
        retryable: true,
      })
      : toProviderError(result, '결제 승인에 실패했습니다.');
  } catch (error) {
    confirmationError = error instanceof TossPaymentError
      ? error
      : new TossPaymentError('결제 승인 결과를 확인하지 못했습니다.');
  }

  // 승인 응답이 유실됐더라도 토스의 주문 조회 결과가 DONE이면 안전하게 후처리를 재개한다.
  let lookupError;
  try {
    const payment = await getTossPaymentByOrderId({ orderId, secretKey, fetchFn });
    if (isVerifiedTossPayment(payment, expected)) {
      return { payment, recovered: true };
    }
    lookupError = new TossPaymentError('조회된 결제 상태가 주문 정보와 일치하지 않습니다.', {
      status: 502,
      code: 'TOSS_RECONCILIATION_MISMATCH',
      retryable: true,
    });
  } catch (error) {
    lookupError = error;
  }

  if (lookupError instanceof TossPaymentError && lookupError.retryable) {
    throw new TossPaymentError('결제 승인 여부를 확정하지 못했습니다. 새로 결제하지 말고 다시 확인해주세요.', {
      status: 502,
      code: lookupError.code || 'TOSS_RECONCILIATION_UNAVAILABLE',
      retryable: true,
    });
  }

  throw confirmationError;
}

export async function cancelOrRecoverTossPayment({
  paymentKey,
  orderId,
  amount,
  cancelReason,
  idempotencyKey,
  secretKey,
  fetchFn = fetch,
}) {
  const expected = { paymentKey, orderId, amount };
  let cancellationError;

  try {
    const result = await requestToss(
      `${TOSS_API_BASE_URL}/payments/${encodeURIComponent(paymentKey)}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: createAuthorization(secretKey),
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ cancelReason }),
      },
      fetchFn,
    );

    if (result.ok && isVerifiedCanceledTossPayment(result.data, expected)) {
      return { payment: result.data, recovered: false };
    }

    cancellationError = result.ok
      ? new TossPaymentError('결제 취소 응답이 주문 정보와 일치하지 않습니다.', {
        status: 502,
        code: 'TOSS_CANCELLATION_MISMATCH',
        retryable: true,
      })
      : toProviderError(result, '결제 취소에 실패했습니다.');
  } catch (error) {
    cancellationError = error instanceof TossPaymentError
      ? error
      : new TossPaymentError('결제 취소 결과를 확인하지 못했습니다.');
  }

  try {
    const payment = await getTossPaymentByOrderId({ orderId, secretKey, fetchFn });
    if (isVerifiedCanceledTossPayment(payment, expected)) {
      return { payment, recovered: true };
    }

    const samePayment = payment
      && payment.paymentKey === paymentKey
      && payment.orderId === orderId
      && payment.totalAmount === amount;

    if (samePayment && payment.status === 'DONE' && cancellationError?.retryable === false) {
      throw new TossPaymentError(cancellationError.message, {
        status: cancellationError.status,
        code: cancellationError.code,
        retryable: false,
        definitivelyNotCanceled: true,
      });
    }
  } catch (error) {
    if (error instanceof TossPaymentError && error.definitivelyNotCanceled) {
      throw error;
    }
  }

  throw new TossPaymentError('환불 상태를 확정하지 못했습니다. 다시 결제하지 말고 환불 확인을 재시도해주세요.', {
    status: 502,
    code: cancellationError?.code || 'TOSS_CANCELLATION_UNAVAILABLE',
    retryable: true,
  });
}
