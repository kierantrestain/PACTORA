import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";

// The Document Builder from start to a ready envelope: pick a starter, fill
// its variables, preview the PDF, and open a draft envelope with every field
// in place. Runs after signing-flow.spec.ts, which sets the site up.

test("a starter document becomes a draft envelope ready to send", async ({
  page,
}) => {
  await signInAsAdministrator(page);

  await page.getByRole("link", { exact: true, name: "Create" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Create a document" }),
  ).toBeVisible();

  const proposal = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Sales proposal" }),
  });

  await proposal.getByRole("button", { name: "Use this" }).click();
  await expect(page).toHaveURL(/\/builder\/[0-9a-f-]+$/);
  await expect(page.getByLabel("Document title")).toHaveValue("Sales proposal");

  // Not ready: the variables are empty and the editor says which.
  await expect(page.getByText(/^Fill in .*\{\{company\.name\}\}/)).toBeVisible();

  for (const [name, value] of [
    ["Your company", "Northwind Studio"],
    ["Client", "Acme Ltd"],
    ["Client contact", "Casey Client"],
    ["Quote valid until", "31 December 2026"],
  ] as const) {
    await page.getByLabel(`Value of ${name}`, { exact: true }).fill(value);
  }

  await expect(page.getByText("Every variable has a value")).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // The preview is a real PDF.
  const documentId = page.url().split("/").at(-1)!;
  const preview = await page.request.get(
    `/api/builder/documents/${documentId}/pdf`,
  );

  expect(preview.status()).toBe(200);
  expect(preview.headers()["content-type"]).toBe("application/pdf");
  expect((await preview.body()).subarray(0, 5).toString()).toBe("%PDF-");

  await page.getByRole("button", { name: "Send for signature" }).click();

  const dialog = page.getByRole("dialog", { name: "Who signs?" });

  await dialog.getByLabel("Full name").fill("Casey Client");
  await dialog.getByLabel("Email").fill("casey.client@example.test");
  await dialog.getByRole("button", { name: "Prepare envelope" }).click();

  await expect(page).toHaveURL(/\/envelopes\/[0-9a-f-]+\/review$/);
  await expect(page.getByText("Casey Client").first()).toBeVisible();

  // The library shows the document with its envelope.
  await page.goto("/builder");
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Sales proposal" })
      .getByText("Envelope drafted"),
  ).toBeVisible();
});
