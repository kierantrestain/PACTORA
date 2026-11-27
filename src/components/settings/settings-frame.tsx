"use client";

import {
  BellIcon,
  Building2Icon,
  DatabaseIcon,
  FileTextIcon,
  MailIcon,
  PaletteIcon,
  SearchIcon,
  ShieldCheckIcon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  findSection,
  LEGACY_SETTINGS_ANCHORS,
  searchSettings,
  settingsHref,
  visibleSections,
  type SettingsSectionId,
  type SettingsViewer,
} from "@/components/settings/settings-index";
import { cn } from "@/lib/cn";

const SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  advanced: WrenchIcon,
  branding: PaletteIcon,
  data: DatabaseIcon,
  documents: FileTextIcon,
  email: MailIcon,
  notifications: BellIcon,
  profile: UserIcon,
  security: ShieldCheckIcon,
  team: UsersIcon,
  workspace: Building2Icon,
};

function currentSectionId(pathname: string): SettingsSectionId | null {
  const match = /^\/settings\/([^/]+)/.exec(pathname);

  return (match?.[1] as SettingsSectionId | undefined) ?? null;
}

/**
 * Sends a link to the single-page Settings (/settings#organization and
 * friends) to the section that holds that part now.
 */
function useLegacyAnchorRedirect() {
  const router = useRouter();
  const pathname = usePathname() ?? "/settings";

  useEffect(() => {
    function redirectFromHash() {
      const hash = window.location.hash.replace(/^#/, "");
      const target = hash ? LEGACY_SETTINGS_ANCHORS[hash] : undefined;

      if (!target) {
        return;
      }

      if (currentSectionId(pathname) === target.section) {
        return;
      }

      router.replace(settingsHref(target.section, target.anchor));
    }

    redirectFromHash();
    window.addEventListener("hashchange", redirectFromHash);

    return () => window.removeEventListener("hashchange", redirectFromHash);
  }, [pathname, router]);
}

export function SettingsFrame({
  children,
  viewer,
}: {
  children: ReactNode;
  viewer: SettingsViewer;
}) {
  const pathname = usePathname() ?? "/settings";
  const router = useRouter();
  const sections = visibleSections(viewer);
  const active = currentSectionId(pathname);

  useLegacyAnchorRedirect();

  return (
    <div className="grid gap-5 lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:gap-8">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="space-y-3">
          <SettingsSearch viewer={viewer} />

          <label className="sr-only" htmlFor="settings-section-select">
            Settings section
          </label>
          <select
            className="field-input font-semibold lg:hidden"
            id="settings-section-select"
            onChange={(event) =>
              router.push(settingsHref(event.target.value as SettingsSectionId))
            }
            value={active ?? ""}
          >
            {active === null ? <option value="">Choose a section</option> : null}
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.label}
              </option>
            ))}
          </select>

          <nav aria-label="Settings" className="hidden lg:block">
            <ul className="space-y-0.5">
              {sections.map((section) => {
                const Icon = SECTION_ICONS[section.id];
                const isActive = section.id === active;

                return (
                  <li key={section.id}>
                    <Link
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex min-h-10 items-center gap-3 rounded-xl px-3 text-sm transition",
                        isActive
                          ? "bg-(--paper) font-bold text-(--fg) shadow-(--shadow-xs)"
                          : "font-semibold text-(--secondary) hover:bg-[rgba(255,255,255,0.65)] hover:text-(--fg)",
                      )}
                      href={settingsHref(section.id)}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          "size-4 shrink-0",
                          isActive ? "text-(--accent)" : "text-(--tertiary)",
                        )}
                      />
                      {section.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </aside>

      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SettingsSearch({ viewer }: { viewer: SettingsViewer }) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  const results = useMemo(() => searchSettings(query, viewer), [query, viewer]);
  const showResults = open && query.trim().length > 0;

  function go(index: number) {
    const item = results[index];

    if (!item) {
      return;
    }

    setQuery("");
    setOpen(false);
    router.push(settingsHref(item.section, item.anchor));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(highlight);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <label className="sr-only" htmlFor={`${listId}-input`}>
        Search settings
      </label>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-(--tertiary)"
      />
      <input
        aria-activedescendant={
          showResults && results[highlight]
            ? `${listId}-option-${highlight}`
            : undefined
        }
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={showResults}
        autoComplete="off"
        className="field-input min-h-11 pl-10"
        id={`${listId}-input`}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="Search settings"
        role="combobox"
        type="search"
        value={query}
      />
      {showResults ? (
        <ul
          className="absolute inset-x-0 top-[calc(100%+0.375rem)] z-20 max-h-80 overflow-y-auto rounded-2xl bg-(--paper) p-1.5 shadow-(--shadow-lg)"
          id={listId}
          role="listbox"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-(--secondary)" role="presentation">
              No settings match “{query.trim()}”.
            </li>
          ) : (
            results.map((item, index) => (
              <li
                aria-selected={index === highlight}
                className={cn(
                  "cursor-pointer rounded-xl px-3 py-2",
                  index === highlight ? "bg-(--accent-softer)" : "",
                )}
                id={`${listId}-option-${index}`}
                key={`${item.section}-${item.anchor}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  go(index);
                }}
                onMouseEnter={() => setHighlight(index)}
                role="option"
              >
                <span className="block text-sm font-semibold text-(--fg)">
                  {item.label}
                </span>
                <span className="block text-xs text-(--tertiary)">
                  {findSection(item.section).label}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** The title and one line that open each settings section. */
export function SettingsPageHeader({
  description,
  title,
}: {
  description?: string;
  title: string;
}) {
  return (
    <header className="space-y-1 px-1 pb-1">
      <h1 className="text-[clamp(1.5rem,2.6vw,1.875rem)] leading-tight font-extrabold tracking-[-0.03em] text-(--fg)">
        {title}
      </h1>
      {description ? (
        <p className="text-[0.9375rem] leading-6 text-(--secondary)">
          {description}
        </p>
      ) : null}
    </header>
  );
}

/** One card of settings, with an anchor the search box can jump to. */
export function SettingsCard({
  action,
  children,
  description,
  id,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  id?: string;
  title?: string;
}) {
  return (
    <section
      className="panel scroll-mt-28 space-y-5 p-5 sm:p-7 target:ring-2 target:ring-[rgb(var(--accent-rgb)/0.35)]"
      id={id}
    >
      {title ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
              {title}
            </h2>
            {description ? (
              <div className="max-w-2xl text-sm leading-6 text-(--secondary)">
                {description}
              </div>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
