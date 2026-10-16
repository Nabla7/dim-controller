// The palette's commands (ui/commands.ts): the multi-word filter, and every panel's header actions (in a fixed order,
// the ones that apply where it is), offered in the palette too.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { type Command, filterCommands, panelActions, panelCommands, panelTitle } from "../src/ui/commands.ts"
import { defaultArrangement, FIXED_PANELS, minimizeStage, movePanel, toggleCollapsed } from "../src/ui/workspace.ts"

const IDS = ["camera:1", ...FIXED_PANELS]
const command = (id: string, label: string, extra: Partial<Command> = {}): Command => ({ id, label, group: "View", run: () => {}, ...extra })

Deno.test("filter: every word must match (label, group, hint, keys, extra words), order kept; empty is everything", () => {
    const all = [command("a", "STOP: stop driving now", { group: "Drive", keys: ["Space"], words: "estop" }), command("b", "Map: show", { group: "Panels" }), command("c", "Reset the layout", { group: "Layout" })]
    assertEquals(filterCommands(all, "").map((c) => c.id), ["a", "b", "c"])
    assertEquals(filterCommands(all, "estop").map((c) => c.id), ["a"])
    assertEquals(filterCommands(all, "space").map((c) => c.id), ["a"])
    assertEquals(filterCommands(all, "map SHOW").map((c) => c.id), ["b"])
    assertEquals(filterCommands(all, "map reset").map((c) => c.id), [])
    assertEquals(filterCommands(all, "  layout  ").map((c) => c.id), ["c"])
})

Deno.test("a panel's header actions, in a fixed order: collapse and make main view (not on the main view), pop out (not on a phone); never close", () => {
    const arrangement = movePanel(defaultArrangement(IDS), "tf", { zone: "float", box: { x: 400, y: 200, width: 300, height: 300 } })
    const actions = (id: string, mobile = false) => panelActions(arrangement, id, { mobile }).map((state) => state.action)
    for (const id of ["map", "scene", "status", "settings", "tf"]) {
        assertEquals(actions(id), ["collapse", "main", "popout"], id)
        assertEquals(actions(id, true), ["collapse", "main"], id)
    }
    // the main view: nothing to collapse or swap
    assertEquals(actions("camera:1"), ["minimize", "popout"])
    assertEquals(actions("camera:1", true), ["minimize"])
})

Deno.test("what each action says depends on where the panel is", () => {
    const arrangement = toggleCollapsed(movePanel(defaultArrangement(IDS), "tf", { zone: "float", box: { x: 400, y: 200, width: 300, height: 300 } }), "map")
    const states = (id: string) => Object.fromEntries(panelActions(arrangement, id, { mobile: false }).map((state) => [state.action, state.label]))
    assert(/Expand/.test(states("map").collapse) && /Collapse/.test(states("scene").collapse))
    assert(/main view/.test(states("scene").main))
    assert(/float/i.test(states("map").popout) && /Dock/.test(states("tf").popout))
})

Deno.test("the palette has a show command and each of the header's actions for every panel", () => {
    const arrangement = defaultArrangement(IDS)
    const acted: string[] = []
    for (const id of IDS) {
        const commands = panelCommands(arrangement, id, panelTitle(id), { mobile: false }, (action) => acted.push(`${id}.${action}`))
        assert(commands[0].label.endsWith(": show"))
        for (const one of commands) {
            one.run()
        }
    }
    assertEquals(acted.filter((entry) => entry.startsWith("map.")), ["map.show", "map.collapse", "map.main", "map.popout"])
    assertEquals(acted.filter((entry) => entry.startsWith("camera:1.")), ["camera:1.show", "camera:1.minimize", "camera:1.popout"])
    assertEquals(panelTitle("camera:2"), "Camera 2")
    assertEquals(panelTitle("scene"), "3D view")
})

Deno.test("minimize sends the main view back and brings the previous one back", () => {
    let arrangement = defaultArrangement(IDS)
    const first = arrangement.stage!
    arrangement = movePanel(arrangement, "map", { zone: "stage" })
    assertEquals(arrangement.stage, "map")
    arrangement = minimizeStage(arrangement)
    assertEquals(arrangement.stage, first)
    assert(arrangement.left.includes("map"))
})
