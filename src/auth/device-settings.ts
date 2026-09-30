import { getDb } from "../db.ts";
import { SETTINGS } from "./types.ts";

/**
 * Whether the device whitelist is being enforced, and how many devices it
 * allows — held in the database rather than the environment so an admin can
 * change it from the panel without a deploy.
 *
 * The marketing site's admin writes this document; this reads it. Both talk to
 * the same MongoDB, which is how the device rows are already shared.
 *
 * Absent means the original behaviour: enforced, two devices. A settings
 * document nobody has written must not quietly unlock the course.
 */

export type DeviceSettings = { enabled: boolean; maxApproved: number };

export const DEVICE_SETTINGS_ID = "devices";
export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { enabled: true, maxApproved: 2 };

/* Read on every sign-in and every refresh, so it is cached briefly. Ten seconds
   is short enough that an admin flipping the switch sees it take effect while
   they are still looking at the page, and long enough that a burst of refreshes
   does not each cost a query. */
const CACHE_MS = 10_000;
let cached: { at: number; value: DeviceSettings } | null = null;

export async function deviceSettings(): Promise<DeviceSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  try {
    const db = await getDb();
    const row = await db.collection(SETTINGS).findOne({ _id: DEVICE_SETTINGS_ID as never });
    const value: DeviceSettings = {
      enabled: typeof row?.enabled === "boolean" ? row.enabled : DEFAULT_DEVICE_SETTINGS.enabled,
      // Guarded rather than trusted: a zero or a negative would lock every
      // buyer out of a course they have paid for.
      maxApproved:
        typeof row?.maxApproved === "number" && row.maxApproved >= 1
          ? Math.floor(row.maxApproved)
          : DEFAULT_DEVICE_SETTINGS.maxApproved,
    };
    cached = { at: Date.now(), value };
    return value;
  } catch {
    // A database that cannot be read must not hand out access. Enforcing is the
    // safe direction to fail in.
    return cached?.value ?? DEFAULT_DEVICE_SETTINGS;
  }
}
