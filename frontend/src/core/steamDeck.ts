// The Steam Deck banner's logic (ui/SteamDeckBanner.tsx). On a Steam Deck (or SteamOS) the Deck's controls only reach
// the page as a gamepad when dimOS was opened from Steam (Steam Input); this app's backend says whether its machine (the
// one Desktop runs on) is a Deck or runs SteamOS (GET api/host), and Desktop opens itself in Steam
// (POST /gateways/desktop/ui/steam/open). No answer (dev server, an older backend): no banner.
// The shell marks a launch from Steam in sessionStorage["dimos.launch"] = "steam" (from ?launch=steam).

/** GET api/host's Steam fields */
export interface SteamDeckInfo {
    steamDeck: boolean
    steamOs: boolean
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** The backend's answer, or null: no backend, an older one, or anything unreadable. Never throws. `page` is the page's URL. */
export async function fetchSteamDeck(fetcher: Fetch, page: string): Promise<SteamDeckInfo | null> {
    try {
        const response = await fetcher(new URL("api/host", page).href)
        if (!response.ok) {
            return null
        }
        const body = await response.json()
        return body && typeof body === "object" ? { steamDeck: body.steamDeck === true, steamOs: body.steamOs === true } : null
    } catch {
        return null
    }
}

/** Shown on a Deck (or SteamOS) when dimOS wasn't opened from Steam and no gamepad is reaching the page, until dismissed. */
export function shouldShowSteamBanner(state: { info: SteamDeckInfo | null; launch: string | null; gamepadConnected: boolean; dismissed: boolean }): boolean {
    return !!state.info && (state.info.steamDeck || state.info.steamOs) && state.launch !== "steam" && !state.gamepadConnected && !state.dismissed
}

/** POST /gateways/desktop/ui/steam/open: what Desktop did ("started", "launched", "restarted", "needs-restart") and its message. `page` is the page's URL (/apps/<name>/). */
export async function openInSteam(fetcher: Fetch, page: string): Promise<{ ok: boolean; did: string; message: string }> {
    try {
        const response = await fetcher(new URL("../../gateways/desktop/ui/steam/open", page).href, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
        const body = await response.json().catch(() => ({}))
        const message = typeof body?.message === "string" ? body.message : typeof body?.reason === "string" ? body.reason : typeof body?.error === "string" ? body.error : ""
        if (!response.ok) {
            return { ok: false, did: "", message: message || `Desktop couldn't open dimOS in Steam (${response.status}).` }
        }
        return { ok: true, did: typeof body?.did === "string" ? body.did : "", message: message || "Opening dimOS in Steam…" }
    } catch (error) {
        return { ok: false, did: "", message: `Desktop couldn't be reached (${(error as Error)?.message ?? error}).` }
    }
}

export const DISMISS_KEY = "lv.steamDeckBanner.dismissed"
export const LAUNCH_KEY = "dimos.launch"
