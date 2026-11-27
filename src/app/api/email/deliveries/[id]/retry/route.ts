import { NextResponse } from "next/server";

import { loadRetryableDelivery } from "@/lib/email/deliveries";
import { processDueDeliveries } from "@/lib/email/engine";
import { emailErrorResponse, requireEmailSession } from "@/lib/email/http";
import { resolveEmailAddresses } from "@/lib/services/email";
import { getSettings } from "@/lib/settings";

// Tries a waiting delivery again now, instead of at its next scheduled try.

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const session = await requireEmailSession(request, {
    mutating: true,
    rateLimit: { limit: 30, name: "delivery_retry", windowMs: 60 * 60 * 1000 },
  });

  if (session instanceof Response) {
    return session;
  }

  const { id } = await context.params;
  const delivery = await loadRetryableDelivery(session.user.id, id);

  if (!delivery) {
    return NextResponse.json(
      { error: "That delivery no longer exists." },
      { status: 404 },
    );
  }

  if (!delivery.retryable) {
    return NextResponse.json(
      {
        error:
          "This message is not waiting to be retried. Send it again from the envelope.",
      },
      { status: 409 },
    );
  }

  try {
    const summary = await processDueDeliveries({
      limit: 1,
      onlyIds: [id],
      resolveAddresses: () => resolveEmailAddresses(),
      resolveOrganizationName: async () =>
        (await getSettings()).organizationName,
    });

    return NextResponse.json({ sent: summary.sent === 1, summary });
  } catch (error) {
    return emailErrorResponse(error, request, {
      fallback: "The delivery could not be retried.",
      userId: session.user.id,
    });
  }
}
