// Creates the owner of a new PACTORA workspace, or chooses one on an install
// that has accounts but no owner. This is the production way to provision
// an owner: it needs the database credentials, never a public web form.
//
//   DATABASE_URL=postgres://... npm run owner:provision -- --email owner@company.com --name "Full Name"
//   DATABASE_URL=postgres://... npm run owner:provision -- --promote someone@company.com
//
// The password is read from OWNER_PASSWORD, or typed at a hidden prompt.

import { createInterface } from "node:readline";

import pg from "pg";

import { resolveDatabaseUrl } from "../src/lib/utils/env.ts";
import {
  OwnerProvisioningError,
  promoteOwner,
  provisionOwner,
} from "../src/lib/owner-cli.ts";

function readArgument(name: string): string | null {
  const index = process.argv.indexOf(name);

  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const output = rl as unknown as { _writeToOutput: (text: string) => void };

    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    output._writeToOutput = (text: string) => {
      if (text.startsWith(question)) {
        process.stdout.write(question);
      }
    };
  });
}

async function main() {
  const connectionString = resolveDatabaseUrl(process.env);

  if (!connectionString) {
    console.error("Set DATABASE_URL to the workspace's database first.");
    process.exit(1);
  }

  const database = new pg.Pool({ connectionString, max: 2 });

  try {
    const promote = readArgument("--promote");

    if (promote) {
      const result = await promoteOwner(promote, database);
      console.log(`${result.email} is now the workspace owner.`);
      return;
    }

    const email = readArgument("--email");
    const name = readArgument("--name");

    if (!email || !name) {
      console.error(
        'Usage: npm run owner:provision -- --email <address> --name "<full name>"',
      );
      process.exit(1);
    }

    const password =
      process.env.OWNER_PASSWORD ??
      (await promptHidden("Password for the owner (15+ characters): "));
    const result = await provisionOwner({ email, name, password }, database);

    console.log(
      `Created the owner ${result.email}. Sign in at your workspace's /login page.`,
    );
  } catch (error) {
    if (error instanceof OwnerProvisioningError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    throw error;
  } finally {
    await database.end();
  }
}

await main();
