import db from "../../db.server";
import { loadShopSettings } from "../settings/save.server";
import { requireShopId } from "../tenancy.server";
import { DEFAULT_DATETIME_PREFS, type DateTimePrefs } from "./datetime";

/** The shop's date/time display preference (Settings → General) + time zone
 *  (Chat availability). Used by the app layout loader and by server-side
 *  formatting (exports, emails, pre-formatted loader data). */
export async function getDateTimePrefs(shopId: string): Promise<DateTimePrefs> {
  requireShopId(shopId);
  const [settings, shop] = await Promise.all([
    loadShopSettings(shopId),
    db.shop.findUnique({ where: { id: shopId }, select: { timezone: true } }),
  ]);
  return {
    dateFormat: settings.storeInfo.dateFormat,
    timeFormat: settings.storeInfo.timeFormat,
    timeZone: shop?.timezone || DEFAULT_DATETIME_PREFS.timeZone,
  };
}
