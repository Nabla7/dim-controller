// The page's lease (core/lease.ts): taken before the heavy streams, taken again after the link drops it, renewed with the
// drive topics, and "takenOver" (with a way back) when a newer viewer takes it.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { afterLost, isLeasedKey, isLeaseRejection, LEASE_GROUP, LEASE_TIMEOUT_MS, LEASED_SUBSCRIBE_KEYS, LeaseKeeper, supportsLeaseTimeout, type LeaseClient } from "../src/core/lease.ts"
import { leaseChip, TAKE_BACK_TEXT, TAKEN_OVER_TEXT } from "../src/ui/barStatus.ts"

type Asked = Parameters<LeaseClient["lease"]>[0]

/** A gateway client whose leases the test ends: `lose(reason)` fires the current lease's onLost, `refuse` fails the next ask. */
function fakeClient() {
    const asked: Asked[] = []
    let listeners: ((reason: string) => void)[] = []
    const client = {
        state: "connected",
        refuse: null as string | null,
        asked,
        lease(options: Asked) {
            asked.push(options)
            if (client.refuse) {
                const error = new Error(client.refuse)
                client.refuse = null
                return Promise.reject(error)
            }
            const mine: ((reason: string) => void)[] = []
            listeners = mine
            return Promise.resolve({ onLost: (listener: (reason: string) => void) => mine.push(listener) })
        },
        lose(reason: string) {
            const current = listeners
            listeners = []
            current.forEach((listener) => listener(reason))
        },
    }
    return client
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

Deno.test("the lease covers cameras and point clouds, not tf or small topics", () => {
    assert(isLeasedKey("dimos/color_image/sensor_msgs.Image"))
    assert(isLeasedKey("dimos/camera/front/sensor_msgs.CompressedImage"))
    assert(isLeasedKey("dimos/lidar/sensor_msgs.PointCloud2"))
    assert(!isLeasedKey("dimos/tf/tf2_msgs.TFMessage"))
    assert(!isLeasedKey("dimos/odom/nav_msgs.Odometry"))
    assert(!isLeasedKey("other/x/sensor_msgs.Image"))
    assertEquals(LEASED_SUBSCRIBE_KEYS, ["dimos/**/sensor_msgs.Image", "dimos/**/sensor_msgs.CompressedImage", "dimos/**/sensor_msgs.PointCloud2"])
    assert(isLeaseRejection('dimos/lidar/sensor_msgs.PointCloud2 is leased by another client (group "dim-controller")'))
    assert(!isLeaseRejection('not authorized to subscribe "dimos/x"'))
    assert(!isLeaseRejection(null))
})

Deno.test("a lost lease: taken over shows, a dropped link takes it again, our own renewal is ignored", () => {
    assertEquals(afterLost("takenOver"), "takenOver")
    assertEquals(afterLost("force-expired by peer 3"), "takenOver")
    assertEquals(afterLost("heartbeat"), "retake")
    assertEquals(afterLost("disconnected"), "retake")
    assertEquals(afterLost("maxSeconds"), "retake")
    assertEquals(afterLost("renewed"), "ignore")
    assertEquals(afterLost("released"), "ignore")
})

Deno.test("takes the lease with takeover allowed, the drive keys and the leased stream keys; renews when the drive keys change", async () => {
    const keeper = new LeaseKeeper()
    const client = fakeClient()
    keeper.setPublish(["dimos/cmd_vel/geometry_msgs.Twist", "dimos/joystick/sensor_msgs.Joy"])
    assert(await keeper.take(client))
    assertEquals(keeper.state.get(), { status: "held", reason: null })
    assertEquals(client.asked[0], { group: LEASE_GROUP, publish: ["dimos/cmd_vel/geometry_msgs.Twist", "dimos/joystick/sensor_msgs.Joy"], subscribe: LEASED_SUBSCRIBE_KEYS, allowTakeover: true })
    keeper.setPublish(["dimos/joystick/sensor_msgs.Joy", "dimos/cmd_vel/geometry_msgs.Twist"])
    assertEquals(client.asked.length, 1, "same keys in another order: no renewal")
    keeper.setPublish(["dimos/tele_cmd_vel/geometry_msgs.Twist"])
    client.lose("renewed") // the client ends the old handle when the renewal is granted
    await settle()
    assertEquals(client.asked.length, 2)
    assertEquals(client.asked[1].publish, ["dimos/tele_cmd_vel/geometry_msgs.Twist"])
    assertEquals(keeper.state.get().status, "held")
})

Deno.test("taken over: says so and stays until take back; a heartbeat lapse takes it again by itself", async () => {
    const keeper = new LeaseKeeper()
    const client = fakeClient()
    await keeper.take(client)
    client.lose("heartbeat")
    await settle()
    assertEquals(client.asked.length, 2, "retaken after a heartbeat lapse")
    assertEquals(keeper.state.get().status, "held")
    client.lose("takenOver")
    assertEquals(keeper.state.get(), { status: "takenOver", reason: "takenOver" })
    keeper.onConnected(client)
    keeper.setPublish(["dimos/cmd_vel/geometry_msgs.Twist"])
    await settle()
    assertEquals(client.asked.length, 2, "not retaken by itself once another viewer has it")
    assert(await keeper.takeBack(client))
    assertEquals(keeper.state.get().status, "held")
    assertEquals(client.asked[2].publish, ["dimos/cmd_vel/geometry_msgs.Twist"])
})

Deno.test("a subscription ended for another viewer's lease means taken over, even when our lease had lapsed", async () => {
    const keeper = new LeaseKeeper()
    const client = fakeClient()
    await keeper.take(client)
    keeper.subscriptionRejected('dimos/lidar/sensor_msgs.PointCloud2 is leased by another client (group "dim-controller")')
    assertEquals(keeper.state.get().status, "takenOver")
    client.lose("heartbeat") // the old handle's late loss doesn't retake
    await settle()
    assertEquals(client.asked.length, 1)
})

Deno.test("a disconnect takes it again once connected; a gateway without leases leaves the page working", async () => {
    const keeper = new LeaseKeeper()
    const client = fakeClient()
    await keeper.take(client)
    client.state = "lost"
    client.lose("disconnected")
    await settle()
    assertEquals([client.asked.length, keeper.state.get().status], [1, "taking"])
    client.state = "connected"
    keeper.onConnected(client)
    await settle()
    assertEquals([client.asked.length, keeper.state.get().status], [2, "held"])

    const old = new LeaseKeeper()
    const oldClient = fakeClient()
    oldClient.refuse = 'no lease group "dim-controller" on the server; pass keys to define it'
    assertEquals(await old.take(oldClient), false)
    assertEquals(old.state.get().status, "unsupported")
    old.onConnected(oldClient)
    await settle()
    assertEquals(oldClient.asked.length, 1, "not asked again")
})

Deno.test("the bar's lease chip: only when taken over, a button back", () => {
    assertEquals(leaseChip({ status: "held", reason: null }), null)
    assertEquals(leaseChip({ status: "unsupported", reason: "x" }), null)
    const chip = leaseChip({ status: "takenOver", reason: "takenOver" })
    assertEquals(chip?.text, `${TAKEN_OVER_TEXT} · ${TAKE_BACK_TEXT}`)
    assertEquals(chip?.tone, "bad")
    assertEquals(leaseChip({ status: "takenOver", reason: null }, true)?.text, TAKE_BACK_TEXT)
})

Deno.test("a lapsed lease isn't taken again when a viewer that leased meanwhile already ended our streams", async () => {
    let rejected: string | null = null
    const keeper = new LeaseKeeper(() => rejected)
    const client = fakeClient()
    await keeper.take(client)
    rejected = 'dimos/cam/sensor_msgs.Image is leased by another client (group "dim-controller")'
    client.lose("heartbeat")
    await settle()
    assertEquals(client.asked.length, 1, "not retaken")
    assertEquals(keeper.state.get(), { status: "takenOver", reason: rejected })
})

Deno.test("timeoutMs (zenoh-gateway 0.5.17) only to a client that sends it", async () => {
    const old = fakeClient()
    assert(!supportsLeaseTimeout(old))
    await new LeaseKeeper().take(old)
    assertEquals("timeoutMs" in old.asked[0], false)
    const newer = fakeClient()
    const asked: Asked[] = []
    // a 0.5.17 client's lease() names timeoutMs in its request
    newer.lease = function (options: Asked & { timeoutMs?: number }) {
        const request = { op: "lease", ...options, timeoutMs: options.timeoutMs }
        asked.push(request)
        return Promise.resolve({ onLost: () => {} })
    } as typeof newer.lease
    assert(supportsLeaseTimeout(newer))
    await new LeaseKeeper().take(newer)
    assertEquals(asked[0].timeoutMs, LEASE_TIMEOUT_MS)
})
