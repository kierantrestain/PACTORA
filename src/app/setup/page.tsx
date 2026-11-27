import { redirect } from "next/navigation";

// First-run setup used to have its own page. The owner account is now
// created from the sign-up page, so old links to /setup land there.
export default function SetupPage() {
  redirect("/signup");
}
