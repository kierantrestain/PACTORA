import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/connection";

// For container health checks and uptime monitors: is the app up, and can
// it reach its database. Says nothing else about the install.

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getDb().query("select 1");

    return NextResponse.json({ database: "ok", status: "ok" });
  } catch {
    return NextResponse.json(
      { database: "unreachable", status: "degraded" },
      { status: 503 },
    );
  }
}
