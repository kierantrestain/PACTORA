import type { Metadata } from "next";

import { InviteShell } from "@/components/auth/invite-shell";
import { getAuthSession } from "@/lib/auth/server";

export const metadata: Metadata = { title: "Join workspace" };

type InvitePageProps = {
  params: Promise<{ token: string }>;
};

// The link in a workspace invitation. The invitation itself is read by the
// page from GET /api/invitations/[token]; this only says who, if anyone, is
// signed in, so that person can accept in one click.
export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const session = await getAuthSession().catch(() => null);

  return (
    <InviteShell
      signedInAs={
        session ? { email: session.user.email, name: session.user.name } : null
      }
      token={token}
    />
  );
}
