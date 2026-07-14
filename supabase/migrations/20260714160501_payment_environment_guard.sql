alter table public.payment_orders
  add column payment_environment text not null default 'test'
    check (payment_environment in ('test', 'live'));

drop function public.list_payment_orders_for_refund(uuid, integer);

create function public.list_payment_orders_for_refund(
  p_user_id uuid,
  p_limit integer default 10
)
returns table (
  order_id text,
  plan_name text,
  amount integer,
  credits integer,
  payment_status text,
  payment_environment text,
  refund_status text,
  created_at timestamptz,
  approved_at timestamptz,
  refunded_at timestamptz,
  can_refund boolean,
  can_retry boolean,
  eligibility_reason text
)
language sql
security invoker
set search_path = ''
as $$
  select
    o.order_id,
    o.plan_name,
    o.amount,
    o.credits,
    o.status,
    o.payment_environment,
    o.refund_status,
    o.created_at,
    o.approved_at,
    o.refunded_at,
    (
      o.status = 'paid'
      and o.refund_status = 'none'
      and p.credits >= o.credits
      and not exists (
        select 1
        from public.usage_logs as u
        where u.user_id = p_user_id
          and u.created_at > o.approved_at
          and coalesce(u.credits_used, 0) > 0
      )
    ) as can_refund,
    (o.status = 'paid' and o.refund_status = 'pending') as can_retry,
    case
      when o.status <> 'paid' then 'not_paid'
      when o.refund_status = 'pending' then 'pending'
      when o.refund_status = 'refunded' then 'refunded'
      when o.refund_status = 'failed' then 'failed'
      when o.refund_status = 'review_required' then 'review_required'
      when p.credits < o.credits then 'insufficient_credits'
      when exists (
        select 1
        from public.usage_logs as u
        where u.user_id = p_user_id
          and u.created_at > o.approved_at
          and coalesce(u.credits_used, 0) > 0
      ) then 'credits_used'
      else null
    end as eligibility_reason
  from public.payment_orders as o
  join public.profiles as p on p.id = o.user_id
  where o.user_id = p_user_id
  order by o.created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 20));
$$;

revoke all on function public.list_payment_orders_for_refund(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.list_payment_orders_for_refund(uuid, integer)
  to service_role;

notify pgrst, 'reload schema';
