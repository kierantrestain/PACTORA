import { AgreementsShell } from "@/components/agreements/agreements-shell";
import {
  listAgreementsForUser,
  type AgreementListResult,
} from "@/lib/agreements";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { parseAgreementListFilters } from "@/lib/schemas/agreement";

type AgreementsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AgreementsPage({
  searchParams,
}: AgreementsPageProps) {
  const filters = parseAgreementListFilters(await searchParams);
  let result: AgreementListResult | undefined;
  let initialState: "error" | undefined;

  try {
    const session = await getAuthSession();

    result = session
      ? await listAgreementsForUser(session.user.id, filters, getDb())
      : undefined;
  } catch {
    initialState = "error";
  }

  return (
    <AgreementsShell
      // New filters start the shell afresh, with its own search box and,
      // for a link to one agreement, its details open.
      key={JSON.stringify(filters)}
      filters={filters}
      initialState={initialState}
      result={result}
    />
  );
}
