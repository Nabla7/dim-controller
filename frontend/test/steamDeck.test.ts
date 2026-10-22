// The Steam Deck banner (core/steamDeck.ts) against a mocked backend and Desktop: shown on a Deck / SteamOS opened outside
// Steam with no gamepad, hidden on an older backend or anything unreadable, and the open call's outcomes.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { fetchSteamDeck, openInSteam, shouldShowSteamBanner, type SteamDeckInfo } from "../src/core/steamDeck.ts"

const PAGE = "http://127.0.0.1:5555/apps/dim-controller/"
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const deck: SteamDeckInfo = { steamDeck: true, steamOs: true }

Deno.test("the backend answers (api/host); none or an older one, an unreachable or odd one is no banner, never an error", async () => {
    const asked: string[] = []
    const answer = await fetchSteamDeck((url) => (asked.push(url), Promise.resolve(json(200, { cpu: null, ...deck }))), PAGE)
    assertEquals(asked, ["http://127.0.0.1:5555/apps/dim-controller/api/host"])
    assertEquals(answer, deck)
    assertEquals(await fetchSteamDeck(() => Promise.resolve(new Response("not found", { status: 404 })), PAGE), null)
    assertEquals(await fetchSteamDeck(() => Promise.reject(new TypeError("offline")), PAGE), null)
    assertEquals(await fetchSteamDeck(() => Promise.resolve(new Response("<html>", { status: 200 })), PAGE), null)
    // fields that aren't booleans read as false
    assertEquals((await fetchSteamDeck(() => Promise.resolve(json(200, { steamDeck: "yes" })), PAGE))?.steamDeck, false)
})

Deno.test("shown on a Deck or SteamOS opened outside Steam with no gamepad, until dismissed", () => {
    const base = { info: deck, launch: null, gamepadConnected: false, dismissed: false }
    assert(shouldShowSteamBanner(base))
    assert(shouldShowSteamBanner({ ...base, info: { steamDeck: false, steamOs: true } }))
    assert(!shouldShowSteamBanner({ ...base, info: { steamDeck: false, steamOs: false } }), "not a Deck")
    assert(!shouldShowSteamBanner({ ...base, info: null }), "no backend answer")
    assert(!shouldShowSteamBanner({ ...base, launch: "steam" }), "opened from Steam")
    assert(!shouldShowSteamBanner({ ...base, gamepadConnected: true }), "the controls already reach the page")
    assert(!shouldShowSteamBanner({ ...base, dismissed: true }))
})

Deno.test("Open dimOS in Steam: POSTs once, says what Desktop did, a 409's reason or an unreachable Desktop", async () => {
    const calls: { url: string; method?: string }[] = []
    const ok = await openInSteam((url, init) => (calls.push({ url, method: init?.method }), Promise.resolve(json(200, { did: "launched", message: "dimOS is opening in Steam" }))), PAGE)
    assertEquals(calls, [{ url: "http://127.0.0.1:5555/gateways/desktop/ui/steam/open", method: "POST" }])
    assertEquals(ok, { ok: true, did: "launched", message: "dimOS is opening in Steam" })
    const restart = await openInSteam(() => Promise.resolve(json(200, { did: "needs-restart", message: "Restart Steam to finish" })), PAGE)
    assertEquals([restart.ok, restart.did], [true, "needs-restart"])
    const refused = await openInSteam(() => Promise.resolve(json(409, { reason: "Steam isn't running" })), PAGE)
    assertEquals(refused, { ok: false, did: "", message: "Steam isn't running" })
    const bare = await openInSteam(() => Promise.resolve(new Response("", { status: 409 })), PAGE)
    assert(!bare.ok && /409/.test(bare.message))
    const gone = await openInSteam(() => Promise.reject(new TypeError("offline")), PAGE)
    assert(!gone.ok && /reached/.test(gone.message))
})
