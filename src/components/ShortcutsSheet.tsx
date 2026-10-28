"use client";

import { useEffect, useState } from "react";
import { formatCombo, isMacPlatform, MOUSE_GESTURES, resolveCommands, UNSUPPORTED_SPINE_KEYS, type KeyGroup } from "@/core/keymap";
import { usePreferencesStore } from "@/store/usePreferencesStore";

const GROUPS: KeyGroup[] = ["Tools", "Keying", "Playback", "Layers", "View", "Edit", "File", "Panels"];

/** Keyboard reference generated from the keymap, so it always matches what the keys do. */
export function ShortcutsSheet() {
  const [mac, setMac] = useState(true);
  const overrides = usePreferencesStore((s) => s.shortcutOverrides);
  const commands = resolveCommands(overrides);
  useEffect(() => setMac(isMacPlatform()), []);

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] leading-snug text-[var(--label-2)]">
        Shortcuts follow Spine&apos;s defaults, so Spine muscle memory works here. Keys marked <span className="text-[var(--label)]">Kinetic</span>{" "}
        are for tools Spine doesn&apos;t have and use keys Spine leaves free. Customize in Preferences (⌘,).
      </p>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {GROUPS.map((group) => (
          <section key={group} aria-label={group}>
            <h3 className="section-title mb-1.5">{group}</h3>
            <ul className="space-y-0.5">
              {commands.filter((c) => c.group === group).map((c) => (
                <li key={c.id} className="flex items-start gap-3 py-1 border-b border-[var(--separator)] last:border-0">
                  <span className="w-24 shrink-0 flex flex-wrap gap-1">
                    {c.keys.slice(0, c.id.startsWith("nudge.") ? 1 : 2).map((k) => (
                      <kbd key={k} className="px-1.5 py-0.5 rounded-[5px] bg-[var(--fill-2)] text-[11.5px] text-[var(--label)] whitespace-nowrap">
                        {formatCombo(k, mac)}
                      </kbd>
                    ))}
                  </span>
                  <span className="flex-1 min-w-0 text-[12.5px] leading-snug">
                    {c.label}
                    {!c.spine && <span className="ml-1.5 text-[10.5px] font-semibold text-[var(--accent-hover)]">Kinetic</span>}
                    {c.note && <span className="block text-[11px] text-[var(--label-3)]">{c.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section aria-label="Mouse">
          <h3 className="section-title mb-1.5">Mouse</h3>
          <ul className="space-y-0.5">
            {MOUSE_GESTURES.map((g) => (
              <li key={g.gesture} className="flex items-start gap-3 py-1 border-b border-[var(--separator)] last:border-0">
                <span className="w-24 shrink-0 text-[11.5px] text-[var(--label)]">{g.gesture}</span>
                <span className="flex-1 text-[12.5px] leading-snug">
                  {g.action}
                  {!g.spine && <span className="ml-1.5 text-[10.5px] font-semibold text-[var(--accent-hover)]">Kinetic</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <p className="text-[11.5px] leading-snug text-[var(--label-3)]">
        Not available yet: {UNSUPPORTED_SPINE_KEYS.filter((u, i, all) => all.findIndex((x) => x.hint === u.hint) === i)
          .map((u) => u.hint.replace(/ isn't available.*$/, "").replace(/\s*\(.*\)$/, ""))
          .join(", ")}
        . Pressing those keys explains why.
      </p>
    </div>
  );
}
