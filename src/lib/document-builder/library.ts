import {
  BUILDER_DOCUMENT_VERSION,
  type BuilderBlock,
  type BuilderContent,
  type BuilderRole,
  type BuilderVariable,
} from "./model.ts";

// Starting points for the documents teams send most. Each is plain content
// in the builder's model: the sender edits it like any other document.
// They are drafting aids, not legal advice; the library page says so.

export type StarterDocument = {
  category: "Sales" | "Legal" | "People" | "Services";
  content: BuilderContent;
  description: string;
  id: string;
  title: string;
};

let counter = 0;

function id(prefix: string): string {
  counter += 1;

  return `${prefix}-${counter.toString(36)}`;
}

const h = (level: 1 | 2 | 3, text: string): BuilderBlock => ({
  id: id("b"),
  level,
  text,
  type: "heading",
});
const p = (text: string): BuilderBlock => ({
  id: id("b"),
  text,
  type: "paragraph",
});
const list = (style: "bullet" | "number", items: string[]): BuilderBlock => ({
  id: id("b"),
  items,
  style,
  type: "list",
});
const sign = (roleId: string): BuilderBlock => ({
  id: id("b"),
  roleId,
  type: "signature",
});
const divider = (): BuilderBlock => ({ id: id("b"), type: "divider" });

function variables(
  entries: [key: string, label: string, value?: string][],
): BuilderVariable[] {
  return entries.map(([key, label, value = ""]) => ({ key, label, value }));
}

function content(
  roles: BuilderRole[],
  vars: BuilderVariable[],
  blocks: BuilderBlock[],
): BuilderContent {
  return {
    blocks,
    pageSize: "letter",
    roles,
    variables: vars,
    version: BUILDER_DOCUMENT_VERSION,
  };
}

function mutualNda(): StarterDocument {
  const roles = [
    { id: "role-company", name: "Company" },
    { id: "role-counterparty", name: "Counterparty" },
  ];

  return {
    category: "Legal",
    content: content(
      roles,
      variables([
        ["company.name", "Your company"],
        ["counterparty.name", "Other party"],
        ["effective_date", "Effective date"],
        ["purpose", "Purpose", "evaluating a possible business relationship"],
        ["term_years", "Years confidentiality lasts", "3"],
        ["governing_law", "Governing law", "the State of Delaware"],
      ]),
      [
        h(1, "Mutual Non-Disclosure Agreement"),
        p(
          'This Mutual Non-Disclosure Agreement is made on {{effective_date}} between **{{company.name}}** and **{{counterparty.name}}** (each a "Party") for the purpose of {{purpose}} (the "Purpose").',
        ),
        h(2, "1. Confidential Information"),
        p(
          '"Confidential Information" means any non-public information disclosed by one Party to the other, in any form, that is marked confidential or that a reasonable person would understand to be confidential.',
        ),
        h(2, "2. Obligations"),
        list("number", [
          "Use Confidential Information only for the Purpose.",
          "Disclose it only to employees and advisers who need to know it and are bound by duties of confidentiality at least as protective as these.",
          "Protect it with at least the care used for one's own confidential information, and never less than reasonable care.",
        ]),
        h(2, "3. Exclusions"),
        p(
          "These obligations do not apply to information that is or becomes public through no fault of the receiving Party, was known to it before disclosure, is independently developed, or is rightfully received from a third party without restriction.",
        ),
        h(2, "4. Term"),
        p(
          "The obligations in this Agreement last for {{term_years}} years from the Effective Date. On request, each Party will return or destroy the other's Confidential Information.",
        ),
        h(2, "5. General"),
        p(
          "This Agreement is governed by the laws of {{governing_law}}. It is the entire agreement between the Parties on its subject and may be signed electronically and in counterparts.",
        ),
        divider(),
        sign("role-company"),
        sign("role-counterparty"),
      ],
    ),
    description:
      "Two-way confidentiality for early conversations, with term and governing law as variables.",
    id: "mutual-nda",
    title: "Mutual NDA",
  };
}

function servicesAgreement(): StarterDocument {
  const roles = [
    { id: "role-provider", name: "Provider" },
    { id: "role-client", name: "Client" },
  ];

  return {
    category: "Services",
    content: content(
      roles,
      variables([
        ["provider.name", "Your company"],
        ["client.name", "Client"],
        ["start_date", "Start date"],
        ["payment_days", "Days to pay an invoice", "30"],
      ]),
      [
        h(1, "Services Agreement and Statement of Work"),
        p(
          'This agreement is between **{{provider.name}}** ("Provider") and **{{client.name}}** ("Client"), starting on {{start_date}}.',
        ),
        h(2, "1. Services"),
        p(
          "Provider will perform the services and deliver the items described in the Statement of Work below. Changes to scope are agreed in writing before work on them starts.",
        ),
        h(2, "2. Statement of Work"),
        {
          currency: "USD",
          id: id("b"),
          rows: [
            {
              description: "Discovery and requirements workshop",
              discountPercent: 0,
              id: id("r"),
              quantity: 1,
              unitPriceCents: 450000,
            },
            {
              description: "Implementation (days)",
              discountPercent: 0,
              id: id("r"),
              quantity: 10,
              unitPriceCents: 120000,
            },
            {
              description: "Training and handover",
              discountPercent: 10,
              id: id("r"),
              quantity: 2,
              unitPriceCents: 90000,
            },
          ],
          taxLabel: "Tax",
          taxPercent: 0,
          type: "pricing",
        },
        h(2, "3. Fees and payment"),
        p(
          "Client pays each invoice within {{payment_days}} days of receiving it. Amounts are exclusive of taxes unless the table above shows them.",
        ),
        h(2, "4. Ownership"),
        p(
          "On full payment, Client owns the deliverables made for it under this agreement. Provider keeps its pre-existing tools and know-how and grants Client a licence to use them as part of the deliverables.",
        ),
        h(2, "5. Term and termination"),
        p(
          "Either party may end this agreement on 30 days' written notice. Client pays for services performed up to the end date.",
        ),
        divider(),
        sign("role-provider"),
        sign("role-client"),
      ],
    ),
    description:
      "Services terms with a priced statement of work, discounts and totals.",
    id: "services-agreement",
    title: "Services agreement + SOW",
  };
}

function salesProposal(): StarterDocument {
  const roles = [{ id: "role-client", name: "Client" }];

  return {
    category: "Sales",
    content: content(
      roles,
      variables([
        ["company.name", "Your company"],
        ["client.name", "Client"],
        ["client.contact", "Client contact"],
        ["valid_until", "Quote valid until"],
      ]),
      [
        h(1, "Proposal for {{client.name}}"),
        p("Prepared for {{client.contact}} by {{company.name}}."),
        h(2, "What you get"),
        list("bullet", [
          "A setup that fits how your team already works.",
          "A named contact for the first 90 days.",
          "Training for every person who will use it.",
        ]),
        h(2, "Investment"),
        {
          currency: "USD",
          id: id("b"),
          rows: [
            {
              description: "Annual licence",
              discountPercent: 15,
              id: id("r"),
              quantity: 1,
              unitPriceCents: 1200000,
            },
            {
              description: "Onboarding package",
              discountPercent: 0,
              id: id("r"),
              quantity: 1,
              unitPriceCents: 250000,
            },
          ],
          taxLabel: "Sales tax",
          taxPercent: 8,
          type: "pricing",
        },
        p("This quote is valid until {{valid_until}}."),
        h(2, "Acceptance"),
        p(
          "Signing below accepts this proposal and the prices in it. We will send an invoice and a start date within two working days.",
        ),
        sign("role-client"),
      ],
    ),
    description:
      "A one-page quote with a pricing table and acceptance signature.",
    id: "sales-proposal",
    title: "Sales proposal",
  };
}

function offerLetter(): StarterDocument {
  const roles = [
    { id: "role-employer", name: "Employer" },
    { id: "role-candidate", name: "Candidate" },
  ];

  return {
    category: "People",
    content: content(
      roles,
      variables([
        ["company.name", "Company"],
        ["candidate.name", "Candidate"],
        ["job_title", "Job title"],
        ["start_date", "Start date"],
        ["salary", "Annual salary"],
        ["manager", "Reports to"],
      ]),
      [
        h(1, "Offer of Employment"),
        p("Dear {{candidate.name}},"),
        p(
          "We are pleased to offer you the position of **{{job_title}}** at {{company.name}}, reporting to {{manager}}, starting on {{start_date}}.",
        ),
        h(2, "Compensation"),
        p(
          "Your annual base salary will be {{salary}}, paid on the company's regular payroll schedule and subject to applicable withholdings.",
        ),
        h(2, "Conditions"),
        list("bullet", [
          "This offer depends on proof of your right to work.",
          "Employment is subject to the company's policies, which may change from time to time.",
        ]),
        p("To accept, sign below. We look forward to working with you."),
        sign("role-employer"),
        sign("role-candidate"),
      ],
    ),
    description: "Role, start date and salary as variables, signed by both.",
    id: "offer-letter",
    title: "Offer letter",
  };
}

function contractorAgreement(): StarterDocument {
  const roles = [
    { id: "role-company", name: "Company" },
    { id: "role-contractor", name: "Contractor" },
  ];

  return {
    category: "Services",
    content: content(
      roles,
      variables([
        ["company.name", "Company"],
        ["contractor.name", "Contractor"],
        ["rate", "Rate", "$95 per hour"],
        ["start_date", "Start date"],
      ]),
      [
        h(1, "Independent Contractor Agreement"),
        p(
          "{{company.name}} engages {{contractor.name}} as an independent contractor from {{start_date}} at {{rate}}.",
        ),
        h(2, "1. Relationship"),
        p(
          "Contractor is not an employee. Contractor controls how the work is done, provides their own equipment and is responsible for their own taxes and insurance.",
        ),
        h(2, "2. Work product"),
        p(
          "Work product created for the Company under this agreement is assigned to the Company on payment.",
        ),
        h(2, "3. Confidentiality"),
        p(
          "Contractor keeps the Company's non-public information confidential during and after the engagement.",
        ),
        {
          fieldType: "checkbox",
          id: id("b"),
          label:
            "I confirm I am engaged as an independent business and not as an employee.",
          required: true,
          roleId: "role-contractor",
          type: "field",
        },
        divider(),
        sign("role-company"),
        sign("role-contractor"),
      ],
    ),
    description:
      "Engagement terms with a required contractor confirmation checkbox.",
    id: "contractor-agreement",
    title: "Contractor agreement",
  };
}

export const starterDocuments: readonly StarterDocument[] = [
  mutualNda(),
  servicesAgreement(),
  salesProposal(),
  offerLetter(),
  contractorAgreement(),
];

export function findStarterDocument(
  starterId: string,
): StarterDocument | undefined {
  return starterDocuments.find((starter) => starter.id === starterId);
}
