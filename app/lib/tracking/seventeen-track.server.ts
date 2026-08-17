// 17Track API v2.4 client (Settings → Order tracking "Integrate with tracking
// app", spec 16 delta). Server-only: the merchant's API key never leaves the
// backend — the widget talks to proxy.order-track, never to 17Track.
// Docs: https://api.17track.net/en/doc?version=v2.4

const BASE = "https://api.17track.net/track/v2.4";

interface SeventeenResponse {
  code?: number;
  data?: {
    accepted?: Array<Record<string, unknown>>;
    rejected?: Array<Record<string, unknown>>;
  };
}

async function call17(
  apiKey: string,
  path: string,
  body?: unknown,
): Promise<SeventeenResponse | null> {
  try {
    const res = await fetch(BASE + path, {
      method: "POST",
      headers: { "17token": apiKey, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) return null;
    return (await res.json()) as SeventeenResponse;
  } catch {
    return null;
  }
}

/** Zero-quota key check: /getquota succeeds only with a valid security key. */
export async function validate17TrackKey(apiKey: string): Promise<boolean> {
  const res = await call17(apiKey, "/getquota");
  return Boolean(res && res.code === 0);
}

export interface ShipmentEvent {
  description: string;
  time: string | null;
  location: string | null;
}

export interface ShipmentInfo {
  /** 17Track main status, e.g. "InTransit", "Delivered". */
  status: string | null;
  carrier: string | null;
  latestEvent: ShipmentEvent | null;
  events: ShipmentEvent[];
}

/* The response nests providers under track_info.tracking.providers (v2.2) or
 * track_info.providers (docs summary) — read both defensively. */
type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function mapEvent(raw: unknown): ShipmentEvent | null {
  const e = obj(raw);
  const description = str(e.description) || str(e.description_translation);
  if (!description) return null;
  return {
    description,
    time: str(e.time_iso) || str(e.time_utc) || str(obj(e.time_raw).date),
    location: str(e.location) || str(obj(e.address).city),
  };
}

function mapTrackInfo(raw: unknown): ShipmentInfo {
  const info = obj(raw);
  const providersRaw = obj(info.tracking).providers ?? info.providers;
  const providers = Array.isArray(providersRaw) ? providersRaw.map(obj) : [];
  const first = providers[0] ?? {};
  const events = Array.isArray(first.events)
    ? first.events.map(mapEvent).filter((e): e is ShipmentEvent => e !== null).slice(0, 5)
    : [];
  return {
    status: str(obj(info.latest_status).status),
    carrier: str(obj(first.provider).name) || str(first.name),
    latestEvent: mapEvent(info.latest_event) ?? events[0] ?? null,
    events,
  };
}

async function fetchInfo(apiKey: string, number: string): Promise<ShipmentInfo | null> {
  const res = await call17(apiKey, "/gettrackinfo", [{ number }]);
  const accepted = res?.data?.accepted?.[0];
  if (!res || res.code !== 0 || !accepted) return null;
  return mapTrackInfo(obj(accepted).track_info);
}

/** Real-time shipment status; auto-registers unknown numbers (carrier
 *  auto-detected by 17Track). Freshly registered numbers may return an empty
 *  status until 17Track's crawlers catch up — callers show a "no events yet"
 *  state, not an error. Null = invalid key / rejected number / API failure. */
export async function get17TrackShipment(
  apiKey: string,
  number: string,
): Promise<ShipmentInfo | null> {
  const existing = await fetchInfo(apiKey, number);
  if (existing) return existing;
  const reg = await call17(apiKey, "/register", [{ number }]);
  if (!reg || reg.code !== 0 || !reg.data?.accepted?.length) return null;
  return (await fetchInfo(apiKey, number)) ?? { status: null, carrier: null, latestEvent: null, events: [] };
}
