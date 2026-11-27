// Captures desktop and mobile screenshots of PACTORA's principal workflows
// against a running instance, for release review.
//
//   BASE_URL=http://localhost:3000 OUT_DIR=docs/pactora/screenshots \
//     node scripts/capture-screenshots.mjs
//
// It signs up the first owner on a fresh database (token-free, as local
// development allows), so point it at a disposable install.

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium, devices } from "playwright";

const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
const outDir = path.resolve(process.env.OUT_DIR ?? "docs/pactora/screenshots");
const email = process.env.SHOT_EMAIL ?? `owner+${Date.now()}@northwind.test`;
const password = "correct horse battery staple 42";

const pages = [
  ["dashboard", "/dashboard"],
  ["builder", "/builder"],
  ["new-envelope", "/envelopes/new"],
  ["agreements", "/agreements"],
  ["templates", "/templates"],
  ["settings-profile", "/settings/profile"],
  ["settings-workspace", "/settings/workspace"],
  ["settings-team", "/settings/team"],
  ["settings-email", "/settings/email"],
  ["settings-notifications", "/settings/notifications"],
  ["settings-security", "/settings/security"],
  ["settings-data", "/settings/data"],
  ["settings-advanced", "/settings/advanced"],
];

async function shoot(page, name) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({
    fullPage: true,
    path: path.join(outDir, `${name}.png`),
  });
  console.log(`captured ${name}`);
}

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const desktop = await browser.newContext({
  baseURL,
  deviceScaleFactor: 1,
  viewport: { height: 900, width: 1440 },
});
const page = await desktop.newPage();

await page.goto("/signup");
await shoot(page, "desktop-signup");
await page.waitForLoadState("networkidle");

if (process.env.SHOT_EMAIL) {
  // An install that already has its owner: sign in as them.
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
} else {
  await page.getByLabel("Full name").fill("Ada Owner");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

await page.waitForURL(/\/dashboard/);

for (const [name, url] of pages) {
  await page.goto(url);
  await shoot(page, `desktop-${name}`);
}

// The connect dialog for a provider, as a person sees it.
await page.goto("/settings/email");
await page.waitForLoadState("networkidle");
await page.getByRole("button", { name: /Zoho Mail/ }).click();
await shoot(page, "desktop-settings-email-connect-zoho");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: /^Gmail/ }).click();
await shoot(page, "desktop-settings-email-connect-gmail");

const cookies = await desktop.cookies();
const mobile = await browser.newContext({ ...devices["iPhone 13"], baseURL });

await mobile.addCookies(cookies);

const phone = await mobile.newPage();

for (const [name, url] of [
  ["dashboard", "/dashboard"],
  ["settings-email", "/settings/email"],
  ["settings-team", "/settings/team"],
  ["builder", "/builder"],
  ["new-envelope", "/envelopes/new"],
]) {
  await phone.goto(url);
  await shoot(phone, `mobile-${name}`);
}

const anonymous = await browser.newContext({
  ...devices["iPhone 13"],
  baseURL,
});
const anonymousPage = await anonymous.newPage();

for (const [name, url] of [
  ["login", "/login"],
  ["signup", "/signup"],
  ["forgot-password", "/forgot-password"],
  ["verify", "/verify"],
]) {
  await anonymousPage.goto(url);
  await shoot(anonymousPage, `mobile-${name}`);
}

const anonymousDesktop = await browser.newContext({
  baseURL,
  viewport: { height: 900, width: 1440 },
});
const loginPage = await anonymousDesktop.newPage();

await loginPage.goto("/login");
await shoot(loginPage, "desktop-login");
await loginPage.goto("/forgot-password");
await shoot(loginPage, "desktop-forgot-password");

await browser.close();
