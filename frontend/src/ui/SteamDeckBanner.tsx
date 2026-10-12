// On a Steam Deck opened outside Steam, the Deck's sticks and buttons don't reach the page as a gamepad: this says so
// and offers to open dimOS in Steam (core/steamDeck.ts). Dismissed, it stays away on this device.
import { useEffect, useState } from "react"
import { useStore } from "../core/store.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"
import { DISMISS_KEY, fetchSteamDeck, LAUNCH_KEY, openInSteam, shouldShowSteamBanner, type SteamDeckInfo } from "../core/steamDeck.ts"
import { Icon } from "./icons.tsx"
import { gamepadStatus } from "./useGamepad.ts"

function launchMarker(): string | null {
    try {
        return sessionStorage.getItem(LAUNCH_KEY)
    } catch {
        return null
    }
}

export function SteamDeckBanner() {
    const [info, setInfo] = useState<SteamDeckInfo | null>(null)
    const [dismissed, setDismissed] = useState(() => readLocal<boolean>(DISMISS_KEY, false) === true)
    const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
    const [busy, setBusy] = useState(false)
    const pad = useStore(gamepadStatus)
    useEffect(() => {
        let live = true
        void fetchSteamDeck(fetch, location.origin).then((answer) => live && setInfo(answer))
        return () => {
            live = false
        }
    }, [])
    if (!shouldShowSteamBanner({ info, launch: launchMarker(), gamepadConnected: pad.connected, dismissed })) {
        return null
    }
    const open = async () => {
        setBusy(true)
        setResult(await openInSteam(fetch, location.origin))
        setBusy(false)
    }
    return (
        <div className="steam-banner dim-panel" role="status" data-testid="steam-deck-banner">
            <Icon name="gamepad" size={16} />
            <span className="steam-text">
                On a Steam Deck the controls only work as a gamepad when dimOS is opened from Steam.
                {result && <span className={`steam-result ${result.ok ? "" : "tone-warn"}`}>{result.message}</span>}
            </span>
            <button type="button" className="dim-btn sm" disabled={busy} onClick={open}>Open dimOS in Steam</button>
            {info?.runGameUrl && <a className="steam-link" href={info.runGameUrl}>or run it from Steam</a>}
            <button type="button" className="dim-btn icon icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => (writeLocal(DISMISS_KEY, true), setDismissed(true))}>
                <Icon name="close" size={14} />
            </button>
        </div>
    )
}
