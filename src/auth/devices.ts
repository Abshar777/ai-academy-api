import { ObjectId } from "mongodb";
import { getDb } from "../db.ts";
import { DEVICES, type Device } from "./types.ts";
import { deviceSettings } from "./device-settings.ts";

/** The fallback ceiling, used when no setting has been written. The live value
 *  comes from the database so an admin can change it without a deploy — see
 *  device-settings.ts. */
export const MAX_APPROVED_DEVICES = 2;

export type DeviceOutcome =
  /** Signed in — an approved device (known, or the auto-approved first one). */
  | { ok: true; device: Device }
  /** A pending/over-limit request. `created` is true only the first time the
   *  browser is recorded, so the caller notifies admins once; `label` names it. */
  | { ok: false; reason: "pending" | "limit"; created: boolean; label: string }
  /** This browser's access was explicitly removed. */
  | { ok: false; reason: "revoked" };

/** A short, human label from the user agent — enough for an admin to tell two
 *  devices apart in the approval list, without a UA-parsing dependency. */
export function labelFromUserAgent(ua?: string): string {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\/|Opera/.test(ua) ? "Opera" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Safari\//.test(ua) ? "Safari" : "Browser";
  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS" :
    /Android/.test(ua) ? "Android" :
    /Mac OS X|Macintosh/.test(ua) ? "macOS" :
    /Windows/.test(ua) ? "Windows" :
    /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Resolves a browser against the two-device whitelist at sign-in, creating the
 * device row as a side effect:
 *   - known + approved  → signs in (touches lastSeen).
 *   - known + pending   → still waiting on an admin.
 *   - known + revoked   → refused.
 *   - new, 0 approved   → auto-approved as the main device, signs in.
 *   - new, 1 approved   → recorded as pending, refused until an admin approves.
 *   - new, ≥2 approved  → recorded as pending but reported as "limit", so an
 *                         admin sees the request yet must free a slot first.
 */
export async function resolveDeviceForLogin(
  userId: ObjectId,
  deviceId: string,
  info: { userAgent?: string; ip?: string },
): Promise<DeviceOutcome> {
  const db = await getDb();
  const devices = db.collection<Device>(DEVICES);
  const now = new Date();

  const settings = await deviceSettings();

  const existing = await devices.findOne({ userId, deviceId });
  if (existing) {
    // Revoked stays revoked, whatever the setting says. Turning the limit off
    // means "stop counting devices", not "forgive the one an admin threw out".
    if (existing.status === "revoked") return { ok: false, reason: "revoked" };
    await devices.updateOne(
      { _id: existing._id },
      { $set: { lastSeenAt: now, userAgent: info.userAgent, ip: info.ip } },
    );
    if (existing.status === "approved") return { ok: true, device: existing };
    if (!settings.enabled) {
      // Was waiting on an admin who is no longer being asked. Promote it rather
      // than letting it sign in on a row that still reads "pending", so the
      // list stays honest and the device survives the limit being switched on.
      await devices.updateOne(
        { _id: existing._id },
        { $set: { status: "approved", approvedAt: now, approvedBy: "device-limit-off" } },
      );
      return { ok: true, device: { ...existing, status: "approved" } };
    }
    return { ok: false, reason: "pending", created: false, label: existing.label ?? "Unknown device" };
  }

  const approvedCount = await devices.countDocuments({ userId, status: "approved" });
  // With the limit off every new browser is its own main device; with it on,
  // only the very first is.
  const isFirst = approvedCount === 0;
  const autoApprove = isFirst || !settings.enabled;
  const status: Device["status"] = autoApprove ? "approved" : "pending";

  const device: Device = {
    userId,
    deviceId,
    status,
    isMain: isFirst,
    label: labelFromUserAgent(info.userAgent),
    userAgent: info.userAgent,
    ip: info.ip,
    createdAt: now,
    approvedAt: autoApprove ? now : null,
    approvedBy: null,
    lastSeenAt: now,
  };

  try {
    const res = await devices.insertOne(device);
    device._id = res.insertedId;
  } catch (err) {
    // Lost a race with a concurrent request for the same browser. Re-read and
    // decide on the row that won, rather than double-inserting.
    if (typeof err === "object" && err !== null && (err as { code?: number }).code === 11000) {
      const row = await devices.findOne({ userId, deviceId });
      if (row?.status === "approved") return { ok: true, device: row };
      if (row?.status === "revoked") return { ok: false, reason: "revoked" };
      return { ok: false, reason: "pending", created: false, label: row?.label ?? "Unknown device" };
    }
    throw err;
  }

  if (autoApprove) return { ok: true, device };
  // A brand-new device beyond the first: pending if a slot is open, otherwise
  // reported as a hard limit (the row still exists for the admin to see).
  // `created: true` — this sign-in first recorded it, so notify admins once.
  return approvedCount >= settings.maxApproved
    ? { ok: false, reason: "limit", created: true, label: device.label ?? "Unknown device" }
    : { ok: false, reason: "pending", created: true, label: device.label ?? "Unknown device" };
}

/**
 * Read-only check used on refresh: the session only stays alive while its
 * browser is still an approved device. A device an admin revokes (or one never
 * approved) fails here, and the caller ends the session.
 */
export async function isDeviceApproved(userId: ObjectId, deviceId: string): Promise<boolean> {
  if (!deviceId) return false;
  const db = await getDb();
  const devices = db.collection<Device>(DEVICES);
  const device = await devices.findOne({ userId, deviceId });
  if (device) await devices.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date() } });

  // Revoked ends the session either way — that is the one decision the switch
  // does not override.
  if (device?.status === "revoked") return false;
  if (device?.status === "approved") return true;

  // Pending, or a browser with no row at all. With the limit off neither is a
  // reason to drop a live session; with it on, both are.
  const settings = await deviceSettings();
  return !settings.enabled;
}
