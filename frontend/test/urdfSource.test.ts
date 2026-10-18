// UrdfSource (core/urdfSource.ts): an empty /mesh_request asks for /urdf_info now, on subscribing and on every connect,
// re-sent until the URDF comes (the first can beat the subscription), and an empty reply isn't a URDF.
import { assertEquals } from "jsr:@std/assert@1"
import { DOMParser } from "https://esm.sh/@xmldom/xmldom@0.8.10"
import { decode, encode } from "../src/core/lcm/lcm.ts"
import { Store } from "../src/core/store.ts"
import type { Connection, ConnectionState } from "../src/core/transport.ts"
import { MESH_REQUEST, URDF_INFO, UrdfSource } from "../src/core/urdfSource.ts"

;(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser

const URDF = `<?xml version="1.0"?><robot name="box"><link name="base_link"><visual><geometry><box size="1 1 1"/></geometry></visual></link></robot>`

function fakeConnection(state: ConnectionState["state"] = "connected") {
    const requests: string[] = []
    const handlers = new Map<string, (message: { bytes: Uint8Array }) => void>()
    const client = {
        publisher(key: string) {
            assertEquals(key, MESH_REQUEST)
            return { put: (bytes: Uint8Array) => requests.push(String(decode("std_msgs.String", bytes).data)), close() {} }
        },
    }
    const status = new Store({ state } as ConnectionState)
    const connection = {
        client: state === "connected" ? client : null,
        status,
        subscribe(key: string, _options: unknown, onMessage: (message: { bytes: Uint8Array }) => void) {
            handlers.set(key, onMessage)
            return () => handlers.delete(key)
        },
    }
    const urdf = (xml: string) => handlers.get(URDF_INFO)!({ bytes: encode("std_msgs.String", { data: xml }) })
    const connect = (to: ConnectionState["state"]) => {
        connection.client = client
        status.update({ state: to })
    }
    return { connection: connection as unknown as Connection, requests, urdf, connect }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

Deno.test("subscribing asks for /urdf_info at once, again until it comes, then not", async () => {
    const { connection, requests, urdf } = fakeConnection()
    const source = new UrdfSource(connection)
    const release = source.acquire()
    assertEquals(requests, [""], "asked as it subscribes")
    await wait(600)
    assertEquals(requests.length >= 2, true, "asked again while none came")
    urdf(URDF)
    assertEquals(source.state.get().description?.name, "box")
    const asked = requests.length
    await wait(600)
    assertEquals(requests.length, asked, "no more once it came")
    assertEquals(requests.every((request) => request === ""), true, "no mesh asked for: a box has none")
    release()
})

Deno.test("every connect asks again; a link that only dipped (degraded) doesn't", async () => {
    const { connection, requests, urdf, connect } = fakeConnection("connecting")
    const source = new UrdfSource(connection)
    const release = source.acquire()
    assertEquals(requests, [], "no client yet")
    connect("connected")
    assertEquals(requests, [""])
    urdf(URDF)
    connect("degraded")
    connect("connected")
    assertEquals(requests, [""])
    connect("lost")
    connect("connected")
    assertEquals(requests, ["", ""], "a reconnect asks again")
    urdf(URDF)
    release()
    connect("lost")
    connect("connected")
    assertEquals(requests, ["", ""], "not once nothing uses it")
    await wait(300)
})

Deno.test("an empty /urdf_info isn't a URDF: what's loaded stays", () => {
    const { connection, urdf } = fakeConnection()
    const source = new UrdfSource(connection)
    const release = source.acquire()
    urdf(URDF)
    urdf("")
    assertEquals(source.state.get().description?.name, "box")
    assertEquals(source.state.get().problem, null)
    release()
})
