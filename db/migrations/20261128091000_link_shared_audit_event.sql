-- PACTORA 1.1: the sender copied a fresh signing link to share by hand
-- (when email is unavailable). Same list as before, plus link_shared.

alter table public.audit_events
  drop constraint if exists audit_events_event_check;

alter table public.audit_events
  add constraint audit_events_event_check
    check (event in (
      'created',
      'sent',
      'viewed',
      'consented',
      'verified',
      'verification_failed',
      'signed',
      'declined',
      'reminded_manual',
      'email_sent',
      'completed',
      'voided',
      'deadline_changed',
      'expired',
      'reminded_auto',
      'reauthentication_failed',
      'copied',
      'signer_corrected',
      'approved',
      'rejected',
      'link_shared'
    ));
