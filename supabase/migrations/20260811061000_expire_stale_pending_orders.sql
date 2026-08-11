-- 결제창을 열었다가 닫기만 해도 pending 주문이 남는데, 정리하는 곳이 없었다.
-- 그 주문은 회원탈퇴를 영구히 막는다(20260716090000_account_deletion_safety.sql).
-- 결제 실패가 늘수록 탈퇴 불가 계정이 비례해 쌓이므로 오래된 주문을 만료시킨다.

alter table public.payment_orders
  drop constraint if exists payment_orders_status_check;

alter table public.payment_orders
  add constraint payment_orders_status_check
  check (status in ('pending', 'paid', 'expired'));

create index if not exists payment_orders_pending_created_at_idx
  on public.payment_orders (created_at)
  where status = 'pending';

create or replace function public.expire_stale_payment_orders(p_older_than_minutes integer default 60)
returns table (expired integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_expired integer;
begin
  if p_older_than_minutes is null or p_older_than_minutes < 10 then
    raise exception using errcode = 'PR001', message = '만료 기준 시간이 너무 짧습니다.';
  end if;

  -- 결제가 끝난 주문(paid)과 환불이 진행 중인 주문은 건드리지 않는다.
  -- payment_key가 있으면 토스에서 승인이 시작된 것이므로 제외한다.
  with stale as (
    update public.payment_orders as o
    set status = 'expired',
        updated_at = now()
    where o.status = 'pending'
      and o.payment_key is null
      and o.refund_status = 'none'
      and o.created_at < now() - make_interval(mins => p_older_than_minutes)
    returning 1
  )
  select count(*)::integer into v_expired from stale;

  return query select v_expired;
end;
$$;

revoke all on function public.expire_stale_payment_orders(integer)
  from public, anon, authenticated;
grant execute on function public.expire_stale_payment_orders(integer) to service_role;
