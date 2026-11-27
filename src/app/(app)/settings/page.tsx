import { redirect } from "next/navigation";

// Settings opens on Profile. A link to the old single page with an anchor
// (/settings#organization) keeps its anchor through the redirect, and the
// settings frame then sends it on to the section that holds it now.
export default function SettingsIndexPage() {
  redirect("/settings/profile");
}
