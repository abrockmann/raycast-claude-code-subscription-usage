import { Cache, getPreferenceValues } from "@raycast/api";
import type { ClaudeUsage, UsageWindow } from "./types";
import { getAuth, KeychainError, subscriptionLabel } from "./keychain";

/** Same usage endpoint the Claude Code CLI uses for its own limit display. */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const cache = new Cache({ namespace: "claude-usage" });

const USAGE_CACHE_KEY = "usage";
/** Serve a cached snapshot if it is younger than this (ms). Keeps menu bar + dashboard from double-fetching. */
const USAGE_TTL = 45_000;

/** Extra attempts for transient upstream errors (5xx) before giving up. */
const MAX_RETRIES = 2;
/** Never block a menu-bar refresh longer than this for a single backoff wait (ms). */
const RETRY_CAP_MS = 4_000;

/** Shared (cross-command) marker: don't hit the endpoint again until this epoch-ms. */
const COOLDOWN_KEY = "cooldownUntil";
/** After a 429 with no `Retry-After`, stay quiet this long before retrying. */
const DEFAULT_COOLDOWN_MS = 60_000;
/** Cap the cooldown so we always recover, even if the server sends an absurd `Retry-After`. */
const MAX_COOLDOWN_MS = 5 * 60_000;

interface Prefs {
  menuBarStyle: string;
  showOpus: boolean;
}

export function getPrefs(): Prefs {
  return getPreferenceValues<Prefs>();
}

export class ClaudeApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    // Identify as Claude Code so the OAuth token is accepted by the usage endpoint.
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-code/2.1.72",
    Accept: "application/json",
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseWindow(raw: any): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const utilization =
    typeof raw.utilization === "number" ? raw.utilization : raw.utilization_pct;
  if (typeof utilization !== "number") return null;
  return {
    utilization: Math.max(0, Math.min(100, utilization)),
    resetsAt:
      typeof raw.resets_at === "string"
        ? raw.resets_at
        : (raw.reset_at ?? null),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Milliseconds to wait per a `Retry-After` header (seconds or HTTP-date), or null if absent/unparseable. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** Epoch-ms until which we should avoid the endpoint after a 429 (0 = no cooldown). */
function getCooldownUntil(): number {
  const raw = cache.get(COOLDOWN_KEY);
  const at = raw ? Number(raw) : 0;
  return Number.isFinite(at) ? at : 0;
}

function startCooldown(ms: number): void {
  const wait = Math.min(Math.max(ms, 0), MAX_COOLDOWN_MS);
  cache.set(COOLDOWN_KEY, String(Date.now() + wait));
}

function clearCooldown(): void {
  if (cache.has(COOLDOWN_KEY)) cache.remove(COOLDOWN_KEY);
}

export async function fetchUsage(options?: {
  force?: boolean;
}): Promise<ClaudeUsage> {
  if (!options?.force) {
    const cached = cache.get(USAGE_CACHE_KEY);
    if (cached) {
      try {
        const snap = JSON.parse(cached) as ClaudeUsage;
        if (Date.now() - snap.fetchedAt < USAGE_TTL) return snap;
      } catch {
        /* refetch */
      }
    }
  }

  // If we recently hit a rate limit, don't hammer the endpoint — that only deepens
  // the limit. Keep showing the last known snapshot until the cooldown elapses, and
  // only surface the rate-limit error when there is nothing cached to fall back to.
  const cooldownUntil = getCooldownUntil();
  if (Date.now() < cooldownUntil) {
    const stale = getCachedUsage();
    if (stale) return stale;
    throw new ClaudeApiError(
      `Rate limited by the API — retrying in ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s.`,
      429,
    );
  }

  let auth;
  try {
    auth = await getAuth();
  } catch (e) {
    const msg =
      e instanceof KeychainError
        ? e.message
        : `Auth error: ${e instanceof Error ? e.message : String(e)}`;
    throw new ClaudeApiError(msg, 401);
  }

  let res: Response;
  let attempt = 0;
  for (;;) {
    try {
      res = await fetch(USAGE_URL, { headers: headers(auth.accessToken) });
    } catch (e) {
      throw new ClaudeApiError(
        `Network error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Back off and retry transient upstream hiccups (5xx), but never block the
    // menu bar for long: if the server asks us to wait longer than the cap, give
    // up now and let the cached snapshot + next poll cover it. A 429 is handled
    // out-of-band via the cooldown below — retrying it inline only adds load.
    const transient = res.status >= 500 && res.status < 600;
    if (transient && attempt < MAX_RETRIES) {
      const wait = retryAfterMs(res) ?? 500 * 2 ** attempt;
      if (wait <= RETRY_CAP_MS) {
        attempt++;
        await sleep(wait);
        continue;
      }
    }
    break;
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new ClaudeApiError(
        "Claude Code session expired or invalid — use Claude Code (or re-login) to refresh it.",
        res.status,
      );
    }
    if (res.status === 429) {
      startCooldown(retryAfterMs(res) ?? DEFAULT_COOLDOWN_MS);
      // Keep the last known numbers on screen instead of an error — far better UX
      // for a passive usage monitor. Only error out when we have nothing cached.
      const stale = getCachedUsage();
      if (stale) return stale;
      throw new ClaudeApiError(
        "Rate limited by the API — try again in a moment.",
        429,
      );
    }
    throw new ClaudeApiError(
      `Usage endpoint responded with HTTP ${res.status}`,
      res.status,
    );
  }

  const text = await res.text();
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ClaudeApiError(
      "Unexpected non-JSON response from the usage endpoint.",
    );
  }

  const extra = raw?.extra_usage;
  const usage: ClaudeUsage = {
    fiveHour: parseWindow(raw?.five_hour),
    sevenDay: parseWindow(raw?.seven_day),
    sevenDayOpus: parseWindow(raw?.seven_day_opus),
    sevenDaySonnet: parseWindow(raw?.seven_day_sonnet),
    extraUsage:
      extra && typeof extra === "object"
        ? {
            isEnabled: Boolean(extra.is_enabled),
            monthlyLimit:
              typeof extra.monthly_limit === "number"
                ? extra.monthly_limit
                : null,
            usedCredits:
              typeof extra.used_credits === "number"
                ? extra.used_credits
                : null,
            utilization:
              typeof extra.utilization === "number" ? extra.utilization : null,
          }
        : null,
    fetchedAt: Date.now(),
    orgName: subscriptionLabel(auth.subscriptionType),
  };

  cache.set(USAGE_CACHE_KEY, JSON.stringify(usage));
  clearCooldown();
  return usage;
}

/** Last cached snapshot regardless of age — used to render something while a refresh fails. */
export function getCachedUsage(): ClaudeUsage | null {
  const cached = cache.get(USAGE_CACHE_KEY);
  if (!cached) return null;
  try {
    return JSON.parse(cached) as ClaudeUsage;
  } catch {
    return null;
  }
}
