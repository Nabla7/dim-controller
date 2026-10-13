// The recorder popover's choices: everything is recorded unless turned off, the biggest streams are offered first,
// and a folder outside Desktop's recordings folder is called out.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { biggestStreams, formatClock, formatRate, inRecordingsFolder, isRecorded, isRpcTopic, recordToggleState, TOP_STREAMS } from "../src/core/recordFormat.ts"
import type { StreamRate } from "../src/core/recorder.ts"

const stream = (topic: string, bytesPerSecond: number): StreamRate => ({
    key: `dimos${topic}/x.Y`,
    topic,
    type: "x.Y",
    bytesPerSecond,
    messagesPerSecond: 1,
    recorded: true,
    maxRate: null,
})

Deno.test("every topic is recorded unless it was turned off, rpc ones too", () => {
    assert(isRecorded("dimos/odom/nav_msgs.Odometry", {}))
    assert(isRecorded("dimos/rpc/x/req/std_msgs.String", {}))
    assert(!isRecorded("dimos/color_image/sensor_msgs.Image", { "dimos/color_image/sensor_msgs.Image": false }))
    assert(isRpcTopic({ key: "", name: "/rpc/planner/req", type: "x.Y" }))
    assert(!isRpcTopic({ key: "", name: "/odom", type: "x.Y" }))
})

Deno.test("the biggest streams: the top five that send anything, biggest first", () => {
    const streams = [stream("/a", 10), stream("/quiet", 0), stream("/b", 5e6), stream("/c", 300), stream("/d", 2e4), stream("/e", 7), stream("/f", 9e5)]
    assertEquals(biggestStreams(streams).map((s) => s.topic), ["/b", "/f", "/d", "/c", "/a"])
    assertEquals(biggestStreams(streams).length, TOP_STREAMS)
    assertEquals(biggestStreams([stream("/quiet", 0)]), [])
})

Deno.test("folders inside Desktop's recordings folder are listed by Recordings; others are called out", () => {
    assert(inRecordingsFolder("/home/u/.dimos/recordings/controller", "/home/u/.dimos/recordings"))
    assert(inRecordingsFolder("/home/u/.dimos/recordings", "/home/u/.dimos/recordings/"))
    assert(!inRecordingsFolder("/home/u/.dimos/recordings-old", "/home/u/.dimos/recordings"))
    assert(!inRecordingsFolder("/tmp/x", "/home/u/.dimos/recordings"))
    assert(inRecordingsFolder("/tmp/x", null), "without Desktop's folder there's nothing to warn about")
})

Deno.test("numbers read at a glance", () => {
    assertEquals(formatClock(9.7), "0:09")
    assertEquals(formatClock(754), "12:34")
    assertEquals(formatClock(3725), "1:02:05")
    assertEquals(formatRate(512), "512 B/s")
    assertEquals(formatRate(20480), "20.5 kB/s")
    assertEquals(formatRate(12.34e6), "12.3 MB/s")
})

Deno.test("the Record toggle (bar and phone HUD): REC at rest, the time while recording, and held while it starts or stops", () => {
    const rest = { active: false, pending: null, unavailable: null, recordNew: true, selected: 0, seconds: 0 } as const
    assertEquals(recordToggleState(rest), { recording: false, text: "REC", disabled: false })
    assertEquals(recordToggleState({ ...rest, active: true, seconds: 75 }), { recording: true, text: formatClock(75), disabled: false })
    assertEquals(recordToggleState({ ...rest, pending: "start" }), { recording: false, text: "Starting…", disabled: true })
    assertEquals(recordToggleState({ ...rest, active: true, pending: "stop" }), { recording: true, text: "Stopping…", disabled: true })
    // the recorder down, or nothing chosen without new streams joining: can't start
    assert(recordToggleState({ ...rest, unavailable: "recorder down" }).disabled)
    assert(recordToggleState({ ...rest, recordNew: false }).disabled)
    assert(!recordToggleState({ ...rest, recordNew: false, selected: 3 }).disabled)
    // a recording can always be stopped, even if every stream was turned off since
    assert(!recordToggleState({ ...rest, active: true, recordNew: false }).disabled)
})
