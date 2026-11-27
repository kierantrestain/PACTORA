import { getDb, queryOne, type DbPool } from "./db/connection.ts";
import { isMissingSchemaError } from "./settings.ts";

// The optional Getting Started checklist. Every step is worked out from
// what the workspace already has, so nothing here can drift from reality;
// only whether the person dismissed the list is stored.

export type OnboardingSteps = {
  brandingAdded: boolean;
  emailConnected: boolean;
  firstDocumentCreated: boolean;
  teamInvited: boolean;
  workspaceNamed: boolean;
};

export type OnboardingState = {
  dismissed: boolean;
  isAdmin: boolean;
  steps: OnboardingSteps;
};

async function hasConnectedEmailAccount(
  userId: string,
  database: DbPool,
): Promise<boolean> {
  try {
    const row = await queryOne<{ connected: boolean }>(
      database,
      `select exists (
         select 1 from public.email_accounts
         where status = 'connected'
           and (scope = 'organization' or owner_user_id = $1)
       ) as connected`,
      [userId],
    );

    return row?.connected === true;
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return false;
    }

    throw error;
  }
}

export async function getOnboardingState(
  userId: string,
  { database = getDb() }: { database?: DbPool } = {},
): Promise<OnboardingState> {
  const row = await queryOne<{
    branding: boolean;
    dismissed: boolean;
    document: boolean;
    invited: boolean;
    is_admin: boolean;
    named: boolean;
  }>(
    database,
    `
      select
        coalesce((select organization_name is not null and btrim(organization_name) <> ''
          from public.app_settings where id), false) as named,
        coalesce((select logo_hash is not null or brand_color is not null
          from public.app_settings where id), false) as branding,
        (exists (select 1 from public.envelopes where user_id = $1)
          or exists (select 1 from public.builder_documents where user_id = $1))
          as document,
        ((select count(*) from public."user") > 1
          or exists (select 1 from public.workspace_invitations)) as invited,
        coalesce((select role = 'admin' from public."user" where id = $1), false)
          as is_admin,
        coalesce((select dismissed_at is not null from public.user_onboarding
          where user_id = $1), false) as dismissed
    `,
    [userId],
  );

  return {
    dismissed: row?.dismissed ?? false,
    isAdmin: row?.is_admin ?? false,
    steps: {
      brandingAdded: row?.branding ?? false,
      emailConnected: await hasConnectedEmailAccount(userId, database),
      firstDocumentCreated: row?.document ?? false,
      teamInvited: row?.invited ?? false,
      workspaceNamed: row?.named ?? false,
    },
  };
}

export async function setOnboardingDismissed(
  userId: string,
  dismissed: boolean,
  { database = getDb() }: { database?: DbPool } = {},
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  await database.query(
    `insert into public.user_onboarding (user_id, dismissed_at, updated_at)
     values ($1, $2, $3)
     on conflict (user_id) do update
       set dismissed_at = excluded.dismissed_at, updated_at = excluded.updated_at`,
    [userId, dismissed ? now : null, now],
  );
}
