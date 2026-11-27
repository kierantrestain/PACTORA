-- Email accounts: the mailboxes PACTORA sends through (PACTORA 1.1).
--
-- * email_accounts: a connected mailbox. An organisation account belongs to
--   the workspace and is managed by administrators; a personal account
--   belongs to one person and only they can see or use it. Credentials
--   (passwords, API keys, OAuth tokens) are stored encrypted with
--   AES-256-GCM (src/lib/email/crypto.ts); the SMTP host, port, security
--   and user name are not secret and are kept in the clear.
-- * email_account_teams: the teams an organisation account is shared with,
--   when it is shared with teams.
-- * email_account_preferences: the account a person prefers to send their
--   agreements through.
-- * email_oauth_states: a pending Google or Microsoft connection. Single
--   use, ten minutes, bound to the person who started it. The PKCE
--   verifier is encrypted; the state itself is kept only as a hash.
-- * email_deliveries: every message sent or attempted, for idempotency,
--   retries and the delivery log. A pending retry's message is stored
--   encrypted and erased once it is sent or given up. envelope_id and
--   sender_user_id carry no foreign key on purpose: a send happens while
--   the envelope's row may be locked by the transaction that sends it, and
--   the log outlives deleted envelopes.
-- * email_templates: an organisation's own subject and opening paragraph
--   for some messages. Links and legal text are never editable.
--
-- Timestamps are unix seconds, as everywhere else.

create table if not exists public.email_accounts (
  id text primary key,
  scope text not null check (scope in ('organization', 'personal')),
  owner_user_id text references public."user"(id) on delete cascade,
  created_by_user_id text references public."user"(id) on delete set null,
  provider text not null check (provider in ('gmail', 'microsoft', 'smtp', 'resend')),
  preset_id text not null check (
    preset_id in (
      'gmail', 'google_workspace', 'microsoft365', 'outlook', 'zoho',
      'yahoo', 'icloud', 'smtp', 'resend'
    )
  ),
  email_address text not null check (length(email_address) between 3 and 320),
  display_name text check (display_name is null or length(display_name) <= 120),
  reply_to text check (reply_to is null or length(reply_to) <= 320),
  status text not null default 'connected'
    check (status in ('connected', 'needs_reconnect', 'error')),
  encrypted_credentials text not null,
  smtp_host text,
  smtp_port integer check (smtp_port is null or smtp_port in (25, 465, 587, 2525)),
  smtp_security text check (smtp_security is null or smtp_security in ('tls', 'starttls')),
  smtp_username text,
  provider_account_id text,
  oauth_scope text,
  daily_limit integer check (daily_limit is null or daily_limit > 0),
  is_default boolean not null default false,
  shared_with text not null default 'nobody'
    check (shared_with in ('nobody', 'everyone', 'teams')),
  last_success_at bigint,
  last_error text,
  last_error_at bigint,
  created_at bigint not null,
  updated_at bigint not null,
  check ((scope = 'personal') = (owner_user_id is not null)),
  check (scope = 'organization' or (not is_default and shared_with = 'nobody'))
);

-- One default organisation account at most.
create unique index if not exists email_accounts_one_default
  on public.email_accounts ((true))
  where is_default;

-- The same mailbox is connected once per owner.
create unique index if not exists email_accounts_personal_mailbox
  on public.email_accounts (owner_user_id, provider, lower(email_address))
  where scope = 'personal';

create unique index if not exists email_accounts_organization_mailbox
  on public.email_accounts (provider, lower(email_address))
  where scope = 'organization';

create index if not exists email_accounts_owner_idx
  on public.email_accounts (owner_user_id)
  where owner_user_id is not null;

create table if not exists public.email_account_teams (
  account_id text not null references public.email_accounts(id) on delete cascade,
  team_id text not null references public.teams(id) on delete cascade,
  primary key (account_id, team_id)
);

create index if not exists email_account_teams_team_idx
  on public.email_account_teams (team_id);

create table if not exists public.email_account_preferences (
  user_id text primary key references public."user"(id) on delete cascade,
  account_id text not null references public.email_accounts(id) on delete cascade,
  updated_at bigint not null
);

create index if not exists email_account_preferences_account_idx
  on public.email_account_preferences (account_id);

create table if not exists public.email_oauth_states (
  state_hash text primary key,
  user_id text not null references public."user"(id) on delete cascade,
  preset_id text not null,
  scope text not null check (scope in ('organization', 'personal')),
  reconnect_account_id text references public.email_accounts(id) on delete cascade,
  encrypted_verifier text not null,
  created_at bigint not null,
  expires_at bigint not null,
  consumed_at bigint
);

create index if not exists email_oauth_states_expiry_idx
  on public.email_oauth_states (expires_at);

create table if not exists public.email_deliveries (
  id text primary key,
  idempotency_key text,
  stream text not null check (stream in ('platform', 'agreement')),
  account_id text references public.email_accounts(id) on delete set null,
  account_email text,
  provider text,
  template text not null,
  to_address text not null,
  subject text not null,
  envelope_id text,
  sender_user_id text,
  status text not null check (
    status in ('sending', 'sent', 'failed', 'retrying', 'deferred', 'superseded')
  ),
  attempts integer not null default 0,
  next_attempt_at bigint,
  locked_until bigint,
  last_error text,
  recovery text,
  provider_message_id text,
  encrypted_payload text,
  created_at bigint not null,
  updated_at bigint not null,
  sent_at bigint
);

create unique index if not exists email_deliveries_idempotency_key
  on public.email_deliveries (idempotency_key)
  where idempotency_key is not null;

create index if not exists email_deliveries_due_idx
  on public.email_deliveries (next_attempt_at)
  where status in ('retrying', 'deferred');

-- Counting what an account sent in the last day, for its sending limit.
create index if not exists email_deliveries_account_sent_idx
  on public.email_deliveries (account_id, sent_at)
  where status = 'sent';

create index if not exists email_deliveries_envelope_idx
  on public.email_deliveries (envelope_id, to_address)
  where envelope_id is not null;

create index if not exists email_deliveries_sender_idx
  on public.email_deliveries (sender_user_id, created_at desc, id);

create index if not exists email_deliveries_created_idx
  on public.email_deliveries (created_at desc, id);

create table if not exists public.email_templates (
  kind text primary key check (
    kind in (
      'signing_invitation', 'automatic_reminder', 'manual_nudge',
      'completion_notification', 'workspace_invitation'
    )
  ),
  subject text not null check (length(subject) between 1 and 200),
  intro text not null check (length(intro) between 1 and 2000),
  updated_by_user_id text references public."user"(id) on delete set null,
  updated_at bigint not null
);
