import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function PaymentPage() {
  const { user, getToken, updateCredits } = useAuth();
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState('');
  const [refundsEnabled, setRefundsEnabled] = useState(false);
  const [confirmingRefund, setConfirmingRefund] = useState(null);
  const [refunding, setRefunding] = useState(null);

  const plans = [
    {
      id: 'basic',
      name: '베이직',
      credits: 100,
      originalPrice: 9900,
      salePrice: 4900,
      discount: 50,
      tone: 'green',
      summary: '가벼운 테스트와 짧은 클립 변환',
      detail: '약 100분 변환',
    },
    {
      id: 'pro',
      name: '프로',
      credits: 300,
      originalPrice: 25900,
      salePrice: 12900,
      discount: 50,
      tone: 'cyan',
      popular: true,
      summary: '인터뷰, 회의, 유튜브 초안 작업',
      detail: '약 300분 변환',
    },
    {
      id: 'creator',
      name: '크리에이터',
      credits: 1000,
      originalPrice: 90000,
      salePrice: 34900,
      discount: 61,
      tone: 'coral',
      summary: '정기 콘텐츠와 대량 자막 작업',
      detail: '약 1,000분 변환',
    },
  ];

  const selectedPlan = plans.find((plan) => plan.id === loading);
  const bestPlan = plans.reduce((best, plan) => (
    plan.salePrice / plan.credits < best.salePrice / best.credits ? plan : best
  ), plans[0]);
  const remainingCredits = Number.isFinite(user?.credits) ? user.credits : 0;

  const loadPaymentOrders = useCallback(async () => {
    if (!user) {
      setOrders([]);
      setRefundsEnabled(false);
      return;
    }

    setOrdersLoading(true);
    setOrdersError('');
    try {
      const res = await fetch('/api/payment/orders', {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '결제 내역을 불러오지 못했습니다.');
      setOrders(data.orders || []);
      setRefundsEnabled(Boolean(data.refundsEnabled));
    } catch (err) {
      setOrdersError(err.message || '결제 내역을 불러오지 못했습니다.');
    } finally {
      setOrdersLoading(false);
    }
  }, [getToken, user]);

  useEffect(() => {
    loadPaymentOrders();
  }, [loadPaymentOrders]);

  async function handlePurchase(plan) {
    if (!user) {
      setError('로그인이 필요합니다.');
      return;
    }

    setError('');
    setSuccess('');
    setLoading(plan.id);

    try {
      const token = getToken();
      const res = await fetch('/api/payment/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ planId: plan.id }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '결제 요청 실패');
      }

      const { orderId, amount, orderName, customerEmail, clientKey } = await res.json();

      const tossPayments = await loadTossPayments(clientKey);
      const payment = tossPayments.payment({ customerKey: user.id });

      await payment.requestPayment({
        method: 'CARD',
        amount: { currency: 'KRW', value: amount },
        orderId,
        orderName,
        customerEmail,
        successUrl: `${window.location.origin}/payment/success`,
        failUrl: `${window.location.origin}/payment/fail`,
      });
    } catch (err) {
      if (err.code === 'USER_CANCEL') {
        setLoading(null);
        return;
      }
      setError(err.message || '결제 중 오류가 발생했습니다.');
    } finally {
      setLoading(null);
    }
  }

  async function handleRefund(order) {
    setError('');
    setSuccess('');
    setOrdersError('');
    setRefunding(order.order_id);

    try {
      const res = await fetch('/api/payment/refund', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ orderId: order.order_id, reason: '고객 요청' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '환불 상태를 확인하지 못했습니다.');

      updateCredits(data.credits);
      setSuccess(data.message || '결제가 전액 환불되었습니다.');
      setConfirmingRefund(null);
      await loadPaymentOrders();
    } catch (err) {
      setError(err.message || '환불 처리 중 오류가 발생했습니다.');
      await loadPaymentOrders();
    } finally {
      setRefunding(null);
    }
  }

  return (
    <div className="payment-page">
      <section className="payment-heading" aria-labelledby="payment-title">
        <p className="workspace-kicker">PAYMENT</p>
        <div className="payment-heading__row">
          <div>
            <h1 id="payment-title" className="workspace-title">변환 시간 충전</h1>
            <p className="workspace-description">
              결제한 시간은 분 단위로 차감되며, 충전된 시간은 만료되지 않습니다.
            </p>
          </div>
          <div className="payment-balance" aria-label="현재 보유 변환 시간">
            <span>현재 보유</span>
            <strong>{remainingCredits.toLocaleString()}분</strong>
          </div>
        </div>
      </section>

      <section className="payment-brief" aria-label="충전 안내">
        <div>
          <span>무료 체험</span>
          <strong>회원가입 시 10분 제공</strong>
        </div>
        <div>
          <span>사용 방식</span>
          <strong>음성 길이 1분당 1분 차감</strong>
        </div>
        <div>
          <span>자막 아이디어</span>
          <strong>성공 5회당 1분 차감 · 실패 무차감</strong>
        </div>
        <div>
          <span>가성비</span>
          <strong>{bestPlan.name} {Math.round(bestPlan.salePrice / bestPlan.credits).toLocaleString()}원/분</strong>
        </div>
      </section>

      {(error || success || selectedPlan) && (
        <div
          className={error ? 'payment-alert payment-alert--error' : 'payment-alert'}
          role={error ? 'alert' : 'status'}
          aria-live={error ? 'assertive' : 'polite'}
        >
          {error || success || `${selectedPlan.name} 결제창을 여는 중입니다.`}
        </div>
      )}

      <section className="payment-plans" aria-label="충전 상품">
        {plans.map((plan) => (
          <article
            key={plan.name}
            className={plan.popular ? 'payment-plan is-popular' : 'payment-plan'}
          >
            {plan.popular && (
              <span className="payment-plan__badge">추천</span>
            )}
            <div className="payment-plan__topline">
              <span className={`payment-plan__mark payment-plan__mark--${plan.tone}`} aria-hidden="true" />
              <span>{plan.detail}</span>
            </div>
            <h2>{plan.name}</h2>
            <p className="payment-plan__summary">{plan.summary}</p>
            <div className="payment-plan__credits">
              <strong>{plan.credits.toLocaleString()}</strong>
              <span>분</span>
            </div>
            <dl className="payment-plan__price">
              <div>
                <dt>판매가</dt>
                <dd>{plan.salePrice.toLocaleString()}원</dd>
              </div>
              <div>
                <dt>정상가</dt>
                <dd>
                  <span>{plan.originalPrice.toLocaleString()}원</span>
                  <em>{plan.discount}%</em>
                </dd>
              </div>
              <div>
                <dt>분당</dt>
                <dd>{Math.round(plan.salePrice / plan.credits).toLocaleString()}원</dd>
              </div>
            </dl>
            <button
              className="gradient-btn payment-plan__button"
              onClick={() => handlePurchase(plan)}
              disabled={loading !== null}
              type="button"
            >
              {loading === plan.id ? '처리 중...' : '충전하기'}
            </button>
          </article>
        ))}
      </section>

      {user && (
        <section className="payment-orders" aria-labelledby="payment-orders-title">
          <div className="payment-orders__heading">
            <div>
              <p className="workspace-kicker">PAYMENT HISTORY</p>
              <h2 id="payment-orders-title">최근 결제</h2>
            </div>
            <span>최근 {orders.length}건</span>
          </div>

          {ordersLoading && orders.length === 0 && (
            <p className="payment-orders__state">결제 내역을 불러오는 중입니다.</p>
          )}
          {!ordersLoading && ordersError && (
            <p className="payment-orders__state payment-orders__state--error">{ordersError}</p>
          )}
          {!ordersLoading && !ordersError && orders.length === 0 && (
            <p className="payment-orders__state">아직 결제 내역이 없습니다.</p>
          )}

          {orders.length > 0 && (
            <div className="payment-order-list">
              {orders.map((order) => {
                const isConfirming = confirmingRefund === order.order_id;
                const isRefunding = refunding === order.order_id;
                const canRequest = refundsEnabled && (order.can_refund || order.can_retry);
                const status = getRefundStatus(order, refundsEnabled);

                return (
                  <article className="payment-order" key={order.order_id}>
                    <div className="payment-order__summary">
                      <div>
                        <strong>{order.plan_name}</strong>
                        <span>{formatDate(order.approved_at || order.created_at)}</span>
                      </div>
                      <div className="payment-order__amount">
                        <strong>{Number(order.amount).toLocaleString()}원</strong>
                        <span>{Number(order.credits).toLocaleString()}분</span>
                      </div>
                    </div>

                    {isConfirming ? (
                      <div className="payment-refund-confirm" role="alert">
                        <p>
                          결제 금액 전액을 취소하고 구매한 {Number(order.credits).toLocaleString()}분을 즉시 회수합니다.
                          이 작업은 되돌릴 수 없습니다.
                        </p>
                        <div>
                          <button
                            className="payment-refund-button payment-refund-button--danger"
                            type="button"
                            disabled={isRefunding}
                            onClick={() => handleRefund(order)}
                          >
                            {isRefunding ? '환불 확인 중...' : '전액 환불 확정'}
                          </button>
                          <button
                            className="payment-refund-button"
                            type="button"
                            disabled={isRefunding}
                            onClick={() => setConfirmingRefund(null)}
                          >
                            취소
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="payment-order__action">
                        <span className={`payment-order__status payment-order__status--${status.tone}`}>
                          {status.label}
                        </span>
                        {canRequest && (
                          <button
                            className="payment-refund-button"
                            type="button"
                            disabled={refunding !== null}
                            onClick={() => setConfirmingRefund(order.order_id)}
                          >
                            {order.can_retry ? '환불 다시 확인' : '전액 환불'}
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function formatDate(value) {
  if (!value) return '승인 대기';
  return new Date(value).toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function getRefundStatus(order, refundsEnabled) {
  if (order.refund_status === 'refunded') return { label: '환불 완료', tone: 'success' };
  if (order.refund_status === 'pending') return { label: '환불 확인 필요', tone: 'warning' };
  if (order.refund_status === 'review_required') return { label: '고객센터 확인 필요', tone: 'danger' };
  if (order.refund_status === 'failed') return { label: '자동 환불 불가', tone: 'danger' };
  if (order.payment_status !== 'paid') return { label: '결제 미완료', tone: 'muted' };
  if (order.eligibility_reason === 'environment_mismatch') return { label: '결제 환경 확인 필요', tone: 'muted' };
  if (!refundsEnabled) return { label: '자동 환불 준비 중', tone: 'muted' };
  if (order.eligibility_reason === 'credits_used') return { label: '사용 후 환불 문의', tone: 'muted' };
  if (order.eligibility_reason === 'insufficient_credits') return { label: '잔여 시간 부족', tone: 'muted' };
  return { label: '환불 가능', tone: 'success' };
}

function loadTossPayments(clientKey) {
  return new Promise((resolve, reject) => {
    if (window.TossPayments) {
      resolve(window.TossPayments(clientKey));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.tosspayments.com/v2/standard';
    script.onload = () => resolve(window.TossPayments(clientKey));
    script.onerror = () => reject(new Error('토스페이먼츠 SDK 로드 실패'));
    document.head.appendChild(script);
  });
}
