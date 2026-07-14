create or replace function public.complete_payment_order(
  p_order_id text,
  p_user_id uuid,
  p_payment_key text
)
returns table (credits integer, charged integer, already_paid boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.payment_orders%rowtype;
  v_credits integer;
begin
  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if not found then
    raise exception '결제 주문을 찾을 수 없습니다.';
  end if;

  if v_order.user_id <> p_user_id then
    raise exception '결제 주문의 사용자가 일치하지 않습니다.';
  end if;

  if v_order.status = 'paid' then
    if v_order.payment_key <> p_payment_key then
      raise exception '이미 다른 결제 정보로 처리된 주문입니다.';
    end if;

    select p.credits
    into v_credits
    from public.profiles as p
    where p.id = p_user_id;

    return query select v_credits, v_order.credits, true;
    return;
  end if;

  update public.profiles as p
  set credits = p.credits + v_order.credits,
      updated_at = now()
  where p.id = p_user_id
  returning p.credits into v_credits;

  if v_credits is null then
    raise exception '사용자 크레딧 정보를 찾을 수 없습니다.';
  end if;

  update public.payment_orders as o
  set status = 'paid',
      payment_key = p_payment_key,
      approved_at = now(),
      updated_at = now()
  where o.order_id = p_order_id;

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    order_id,
    description
  ) values (
    p_user_id,
    'charge',
    -v_order.credits,
    v_order.order_id,
    format('%s 결제 (%s원)', v_order.plan_name, to_char(v_order.amount, 'FM999,999,999,990'))
  );

  return query select v_credits, v_order.credits, false;
end;
$$;

revoke all on function public.complete_payment_order(text, uuid, text) from public, anon, authenticated;
grant execute on function public.complete_payment_order(text, uuid, text) to service_role;

notify pgrst, 'reload schema';
