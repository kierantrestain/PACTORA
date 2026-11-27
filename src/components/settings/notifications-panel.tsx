import Link from "next/link";

import { SettingsCard } from "@/components/settings/settings-frame";

// What PACTORA sends, to whom and when. The mailbox it is sent from and
// the wording are in Email & Integrations; reminders are chosen per
// envelope when it is sent.

const MESSAGES: { audience: string; name: string; when: string }[] = [
  {
    audience: "Signers",
    name: "Signing invitation",
    when: "When it is their turn to sign.",
  },
  {
    audience: "Signers",
    name: "Reminders",
    when: "Automatically at the interval chosen when sending, or when you send one.",
  },
  {
    audience: "Signers",
    name: "Emailed code",
    when: "When an envelope asks signers to confirm their address.",
  },
  {
    audience: "You",
    name: "Declined or rejected",
    when: "As soon as a signer declines or an approver rejects.",
  },
  {
    audience: "Everyone",
    name: "Agreement completed",
    when: "When the last person signs, with the signed PDF and certificate.",
  },
  {
    audience: "Signers",
    name: "Envelope voided",
    when: "When you void an envelope they were sent.",
  },
  {
    audience: "You",
    name: "Expiry and renewal",
    when: "Before an envelope's deadline and an agreement's renewal date.",
  },
  {
    audience: "Members",
    name: "Account emails",
    when: "Verification, password reset and workspace invitations.",
  },
];

export function NotificationsPanel({ isAdmin }: { isAdmin: boolean }) {
  return (
    <SettingsCard
      description={
        <>
          Messages go out from the mailbox chosen in{" "}
          <Link className="link" href="/settings/email#send-from">
            Email &amp; Integrations
          </Link>
          {isAdmin ? (
            <>
              , where administrators can also change their{" "}
              <Link className="link" href="/settings/email#templates">
                wording
              </Link>
            </>
          ) : null}
          . Every attempt is listed in the{" "}
          <Link className="link" href="/settings/email#deliveries">
            delivery history
          </Link>
          .
        </>
      }
      id="emails"
      title="Emails people receive"
    >
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="text-xs text-(--tertiary)">
            <tr>
              <th className="px-1 py-2 font-semibold" scope="col">
                Message
              </th>
              <th className="px-1 py-2 font-semibold" scope="col">
                Sent to
              </th>
              <th className="px-1 py-2 font-semibold" scope="col">
                When
              </th>
            </tr>
          </thead>
          <tbody>
            {MESSAGES.map((message) => (
              <tr className="border-t border-(--border)" key={message.name}>
                <td className="px-1 py-2.5 font-semibold text-(--fg)">
                  {message.name}
                </td>
                <td className="px-1 py-2.5 text-(--secondary)">
                  {message.audience}
                </td>
                <td className="px-1 py-2.5 text-(--secondary)">
                  {message.when}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingsCard>
  );
}
