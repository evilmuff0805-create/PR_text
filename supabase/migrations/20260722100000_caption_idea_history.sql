alter table public.caption_idea_requests
  alter column ideas_expires_at set default (now() + interval '90 days');

update public.caption_idea_requests
set ideas_expires_at = created_at + interval '90 days'
where ideas is not null
  and ideas_expires_at < created_at + interval '90 days';

comment on column public.caption_idea_requests.ideas is
  'Three generated caption ideas retained for user history for up to 90 days.';

notify pgrst, 'reload schema';
