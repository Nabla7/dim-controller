// The page's drive lease (core/lease.ts): publish keys only (watching needs none), taken on the first command, renewed
// when the keys change, "takenOver" (with a way back) when a newer viewer drives, and taken back by a new command.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { afterLost, LEASE_GROUP, LEASE_TIMEOUT_MS, LeaseKeeper, RETAKE_AFTER_IDLE_MS, type LeaseClient } from "../src/core/lease.ts"
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

const CMD_VEL = "dimos/cmd_vel/geometry_msgs.Twist"
const JOY = "dimos/joystick/sensor_msgs.Joy"
const JOINTS = "dimos/joint_command/sensor_msgs.JointState"

/** A keeper on a clock the test moves. */
function keeperAt() {
    const clock = { now: 10_000 }
    return { keeper: new LeaseKeeper(() => clock.now), clock }
}

Deno.test("a lost lease: taken over shows, a dropped link waits for the next command, our own renewal is ignored", () => {
    assertEquals(afterLost("takenOver"), "takenOver")
    assertEquals(afterLost("force-expired by peer 3"), "takenOver")
    assertEquals(afterLost("heartbeat"), "lapsed")
    assertEquals(afterLost("disconnected"), "lapsed")
    assertEquals(afterLost("maxSeconds"), "lapsed")
    assertEquals(afterLost("renewed"), "ignore")
    assertEquals(afterLost("released"), "ignore")
})

Deno.test("nothing is leased until a command: watching takes no lease", async () => {
    const { keeper } = keeperAt()
    const client = fakeClient()
    keeper.setPublish([CMD_VEL, JOY])
    await settle()
    assertEquals(client.asked.length, 0)
    assertEquals(keeper.state.get().status, "off")
})

Deno.test("the first command takes it: publish keys only, no subscribe keys, takeover allowed; renewed when the keys change", async () => {
    const { keeper } = keeperAt()
    const client = fakeClient()
    keeper.setPublish([CMD_VEL, JOY])
    keeper.command(client, CMD_VEL)
    await settle()
    assertEquals(keeper.state.get(), { status: "held", reason: null, timeoutMs: null })
    assertEquals(client.asked[0], { group: LEASE_GROUP, publish: [CMD_VEL, JOY], subscribe: [], allowTakeover: true, timeoutMs: LEASE_TIMEOUT_MS })
    keeper.command(client, CMD_VEL)
    keeper.setPublish([JOY, CMD_VEL])
    await settle()
    assertEquals(client.asked.length, 1, "held, same keys in another order: no renewal")
    keeper.command(client, JOINTS) // an arm command adds its key
    client.lose("renewed") // the client ends the old handle when the renewal is granted
    await settle()
    assertEquals(client.asked.length, 2)
    assertEquals(client.asked[1].publish, [CMD_VEL, JOINTS, JOY])
    assertEquals(keeper.state.get().status, "held")
})

Deno.test("taken over: says so; a held key doesn't take it back, a new command after a pause does, and so does take back", async () => {
    const { keeper, clock } = keeperAt()
    const client = fakeClient()
    keeper.setPublish([CMD_VEL])
    keeper.command(client, CMD_VEL)
    await settle()
    client.lose("takenOver")
    assertEquals(keeper.state.get(), { status: "takenOver", reason: "takenOver" })
    for (let tick = 0; tick < 40; tick++) {
        clock.now += 50 // still holding the key at 20 Hz: the other viewer keeps it
        keeper.command(client, CMD_VEL)
    }
    await settle()
    assertEquals(client.asked.length, 1)
    clock.now += RETAKE_AFTER_IDLE_MS
    keeper.command(client, CMD_VEL) // a new press: the newest driver wins
    await settle()
    assertEquals([client.asked.length, keeper.state.get().status], [2, "held"])
    client.lose("takenOver")
    assert(await keeper.takeBack(client))
    assertEquals([client.asked.length, keeper.state.get().status], [3, "held"])
})

Deno.test("a lapse or reconnect waits for the next command; a gateway without leases leaves driving unleased", async () => {
    const { keeper } = keeperAt()
    const client = fakeClient()
    keeper.command(client, CMD_VEL)
    await settle()
    client.lose("heartbeat")
    await settle()
    assertEquals([client.asked.length, keeper.state.get().status], [1, "off"])
    keeper.command(client, CMD_VEL)
    await settle()
    assertEquals([client.asked.length, keeper.state.get().status], [2, "held"])
    keeper.sessionReplaced()
    assertEquals(keeper.state.get().status, "off")
    keeper.command(client, CMD_VEL)
    await settle()
    assertEquals([client.asked.length, keeper.state.get().status], [3, "held"])

    const old = keeperAt().keeper
    const oldClient = fakeClient()
    oldClient.refuse = 'no lease group "dim-controller" on the server; pass keys to define it'
    old.command(oldClient, CMD_VEL)
    await settle()
    assertEquals(old.state.get().status, "unsupported")
    old.command(oldClient, CMD_VEL)
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

Deno.test("timeoutMs 5000 always asked; a 0.5.17 gateway echoes it, an older one leaves the lease on the connection's deadline", async () => {
    const old = fakeClient()
    const oldKeeper = new LeaseKeeper()
    await oldKeeper.take(old)
    assertEquals(old.asked[0].timeoutMs, LEASE_TIMEOUT_MS)
    assertEquals(oldKeeper.state.get(), { status: "held", reason: null, timeoutMs: null })
    const newer = fakeClient()
    const plain = newer.lease
    newer.lease = (options: Asked) => plain(options).then((lease) => ({ ...lease, timeoutMs: options.timeoutMs }))
    const keeper = new LeaseKeeper()
    await keeper.take(newer)
    assertEquals(keeper.state.get(), { status: "held", reason: null, timeoutMs: LEASE_TIMEOUT_MS })
})
