// The 2D map panel's app side: topic discovery that outlives a missed round, and what the panel remembers per viewer.
// (The map itself is dimos-react's Map2D, tested there.)
import { assert, assertEquals } from "jsr:@std/assert@1"
import { rememberTopics, type Topic } from "../src/logic/connection.ts"
import { loadMapLayout } from "../src/logic/mapLayout.ts"

const topic = (name: string, type: string): Topic => ({ key: `dimos${name}/${type}`, name, type })

Deno.test("discovery: a slow topic that misses a round stays listed until it's been gone a while", () => {
    const lidar = topic("/lidar", "sensor_msgs.PointCloud2");
    const globalMap = topic("/global_map", "sensor_msgs.PointCloud2");
    const lastSeen = new Map();
    assertEquals(rememberTopics(lastSeen, [lidar, globalMap], 0, 10_000).map((t: Topic) => t.name), ["/global_map", "/lidar"]);
    // the 0.5 Hz map wasn't caught by this round's probe: still there (the panel doesn't flip to /lidar and wipe it)
    assertEquals(rememberTopics(lastSeen, [lidar], 2_000, 10_000).map((t: Topic) => t.name), ["/global_map", "/lidar"]);
    // gone for longer than the window: dropped
    assertEquals(rememberTopics(lastSeen, [lidar], 12_001, 10_000).map((t: Topic) => t.name), ["/lidar"]);
});
Deno.test("layout: a first-time viewer gets the map folded; an open or a fold is remembered; following is not", () => {
    const screen = { width: 1400, height: 900 };
    const fresh = loadMapLayout({}, screen);
    assertEquals([fresh.collapsed, fresh.followFrame], [true, "base_link"]);
    assertEquals(loadMapLayout({ collapsed: false }, screen).collapsed, false);
    assertEquals(loadMapLayout({ collapsed: true }, screen).collapsed, true);
    assertEquals(loadMapLayout({ followFrame: "odom" }, screen).followFrame, "odom");
    assertEquals(loadMapLayout({ followFrame: 7 } as never, screen).followFrame, "base_link");
    // an old entry's follow: false doesn't survive a reload
    assert(!("follow" in loadMapLayout({ follow: false } as never, screen)));
});
