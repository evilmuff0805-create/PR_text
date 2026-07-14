create index usage_logs_user_created_at_idx
  on public.usage_logs (user_id, created_at desc);
