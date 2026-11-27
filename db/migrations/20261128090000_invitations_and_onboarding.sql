-- PACTORA 1.1: invitations to join the workspace, and the dismissible
-- Getting Started checklist. Additive only.

create table if not exists public.workspace_invitations (
  id text primary key,
  email text not null check (length(btrim(email)) between 3 and 320),
  role text not null default 'user' check (role in ('user', 'admin')),
  -- Only a SHA-256 of the link's token is kept; the link itself is shown
  -- to the administrator once and emailed.
  token_hash text not null unique check (length(token_hash) = 64),
  invited_by_user_id text references public."user"(id) on delete set null,
  created_at bigint not null,
  expires_at bigint not null,
  accepted_at bigint,
  accepted_user_id text references public."user"(id) on delete set null,
  revoked_at bigint
);

-- At most one open invitation per address. Inviting again replaces it.
create unique index if not exists workspace_invitations_open_email
  on public.workspace_invitations (lower(email))
  where accepted_at is null and revoked_at is null;

create table if not exists public.user_onboarding (
  user_id text primary key references public."user"(id) on delete cascade,
  dismissed_at bigint,
  updated_at bigint not null
);
