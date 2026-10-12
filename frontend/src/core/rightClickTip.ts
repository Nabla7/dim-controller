// One-time tip: a double click (two clicks within 500 ms) on the 3D view says "Try right-click" (Desktop's narration,
// else an in-app note), at most once a session; the first right click on the view retires it for good (localStorage).
import { underDesktop } from "../dim-app/source/notify.js"

export const RIGHT_CLICK_TIP_KEY = "controller.rightClickTip.done"
export const RIGHT_CLICK_TIP_TEXT = "Try right-click"
export const DOUBLE_CLICK_MS = 500

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">

function localStore(): Storage | undefined {
    try {
        return globalThis.localStorage
    } catch {
        return undefined
    }
}

export function createRightClickTip({ show, storage = localStore() }: { show: () => void; storage?: Storage }) {
    let lastClick = -Infinity
    let shown = false
    const retired = () => {
        try {
            return storage?.getItem(RIGHT_CLICK_TIP_KEY) === "1"
        } catch {
            return false
        }
    }
    return {
        /** a left click on the view at `time` ms; true when it showed the tip */
        click(time: number) {
            if (shown || retired()) {
                return false
            }
            if (time - lastClick <= DOUBLE_CLICK_MS) {
                shown = true
                show()
                return true
            }
            lastClick = time
            return false
        },
        /** the user right-clicked the view: never show the tip again */
        rightClicked() {
            shown = true
            try {
                storage?.setItem(RIGHT_CLICK_TIP_KEY, "1")
            } catch {
                // private window / blocked storage: the session flag still holds
            }
        },
    }
}

/** Shows `text` as Desktop's narration (POST /api/desktop/narration); false when not under Desktop or it failed. */
export async function narrate(text: string): Promise<boolean> {
    if (!underDesktop()) {
        return false
    }
    try {
        const response = await fetch("/api/desktop/narration", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
        })
        return response.ok
    } catch {
        return false
    }
}
