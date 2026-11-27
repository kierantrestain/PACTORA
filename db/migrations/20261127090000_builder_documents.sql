-- Document Builder: agreements written in PACTORA instead of uploaded.
--
-- A builder document is its title and its content, stored whole as JSON
-- because it is only ever read and written whole: the blocks, the signer
-- roles and the variables (see src/lib/document-builder/model.ts, which
-- checks the content on every save). `is_template` marks a document kept
-- in the sender's own library to start new ones from.
--
-- When a document is sent for signature it is rendered to a PDF and an
-- ordinary draft envelope is made from it; `envelope_id` points at the
-- latest one. Deleting the envelope leaves the document.
--
-- `revision` counts saves, so two open editors cannot silently overwrite
-- each other.

create table if not exists public.builder_documents (
  id text primary key,
  user_id text not null references public."user"(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  content jsonb not null,
  is_template boolean not null default false,
  envelope_id text references public.envelopes(id) on delete set null,
  revision integer not null default 0 check (revision >= 0),
  created_at bigint not null default (extract(epoch from now())::bigint),
  updated_at bigint not null default (extract(epoch from now())::bigint),
  constraint builder_documents_content_check check (
    jsonb_typeof(content) = 'object'
    and octet_length(content::text) <= 1048576
  )
);

create index if not exists idx_builder_documents_user_updated_at
  on public.builder_documents(user_id, updated_at desc, id);

create index if not exists idx_builder_documents_envelope
  on public.builder_documents(envelope_id)
  where envelope_id is not null;
