import { NextResponse } from "next/server";
import { z } from "zod";

import { isAdministrator } from "@/lib/email/accounts";
import {
  emailErrorResponse,
  readJson,
  requireEmailSession,
} from "@/lib/email/http";
import {
  EDITABLE_TEMPLATE_KINDS,
  listTemplates,
  saveTemplate,
} from "@/lib/email/templates";

// The organisation's wording for its messages. Everyone may read it;
// administrators change it.

const templateSchema = z.object({
  intro: z.string().max(4000),
  kind: z.enum(EDITABLE_TEMPLATE_KINDS),
  subject: z.string().max(400),
});

export async function GET(request: Request) {
  const session = await requireEmailSession(request);

  if (session instanceof Response) {
    return session;
  }

  return NextResponse.json({
    canEdit: await isAdministrator(session.user.id),
    templates: await listTemplates(),
  });
}

export async function PUT(request: Request) {
  const session = await requireEmailSession(request, {
    json: true,
    mutating: true,
  });

  if (session instanceof Response) {
    return session;
  }

  if (!(await isAdministrator(session.user.id))) {
    return NextResponse.json(
      { error: "Only an administrator can change email templates." },
      { status: 403 },
    );
  }

  const parsed = templateSchema.safeParse(await readJson(request));

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the template." }, { status: 400 });
  }

  try {
    await saveTemplate(parsed.data, session.user.id);

    return NextResponse.json({ templates: await listTemplates() });
  } catch (error) {
    return emailErrorResponse(error, request, {
      fallback: "The template could not be saved.",
      userId: session.user.id,
    });
  }
}
