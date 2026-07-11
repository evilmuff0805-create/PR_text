create table public.payment_orders (
  order_id text primary key check (char_length(order_id) between 6 and 64),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan_id text not null,
  plan_name text not null,
  amount integer not null check (amount > 0),
  credits integer not null check (credits > 0),
  status text not null default 'pending' check (status in ('pending', 'paid')),
  payment_key text unique,
  idempotency_key uuid not null unique default gen_random_uuid(),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index payment_orders_user_created_at_idx
  on public.payment_orders (user_id, created_at desc);

alter table public.payment_orders enable row level security;

revoke all on table public.payment_orders from anon, authenticated;
grant select, insert, update on table public.payment_orders to service_role;

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
  select *
  into v_order
  from public.payment_orders
  where order_id = p_order_id
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
    from public.profiles p
    where p.id = p_user_id;

    return query select v_credits, v_order.credits, true;
    return;
  end if;

  update public.profiles
  set credits = credits + v_order.credits,
      updated_at = now()
  where id = p_user_id
  returning profiles.credits into v_credits;

  if v_credits is null then
    raise exception '사용자 크레딧 정보를 찾을 수 없습니다.';
  end if;

  update public.payment_orders
  set status = 'paid',
      payment_key = p_payment_key,
      approved_at = now(),
      updated_at = now()
  where order_id = p_order_id;

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

create or replace function public.deduct_credits(
  p_user_id uuid,
  p_credits integer
)
returns integer
language sql
security invoker
set search_path = ''
as $$
  update public.profiles
  set credits = credits - p_credits,
      updated_at = now()
  where id = p_user_id
    and credits >= p_credits
  returning credits;
$$;

revoke all on function public.deduct_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.deduct_credits(uuid, integer) to service_role;

notify pgrst, 'reload schema';
