// The one-time "Try right-click" tip: a double click shows it once a session, a right click retires it for good.
import { assertEquals } from "jsr:@std/assert@1"
import { createRightClickTip, RIGHT_CLICK_TIP_KEY } from "../src/logic/rightClickTip.ts"

function memoryStorage() {
    const items = new Map<string, string>()
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
}

Deno.test("two clicks within 500 ms show the tip, once a session", () => {
    let shows = 0
    const tip = createRightClickTip({ show: () => shows++, storage: memoryStorage() })
    assertEquals(tip.click(0), false)
    assertEquals(tip.click(700), false)
    assertEquals(tip.click(1100), true)
    assertEquals(tip.click(1200), false)
    assertEquals(tip.click(1300), false)
    assertEquals(shows, 1)
})

Deno.test("a right click retires the tip across sessions", () => {
    const storage = memoryStorage()
    let shows = 0
    createRightClickTip({ show: () => shows++, storage }).rightClicked()
    assertEquals(storage.getItem(RIGHT_CLICK_TIP_KEY), "1")
    const next = createRightClickTip({ show: () => shows++, storage })
    next.click(0)
    assertEquals(next.click(100), false)
    assertEquals(shows, 0)
})

Deno.test("storage that throws still works for the session", () => {
    const storage = {
        getItem: () => {
            throw new Error("blocked")
        },
        setItem: () => {
            throw new Error("blocked")
        },
    }
    let shows = 0
    const tip = createRightClickTip({ show: () => shows++, storage })
    tip.click(0)
    assertEquals(tip.click(100), true)
    tip.rightClicked()
    assertEquals(shows, 1)
})
