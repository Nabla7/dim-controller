// The palette's commands for this page as it is now (ui/commands.ts has the shape and the filter): driving first (STOP,
// Reconnect), then every panel's actions, the layout, cameras, the view, recording, the robot type and help.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { recorder } from "../core/recorder.ts"
import { cameraTabs } from "../core/cameraChoice.ts"
import { profiles } from "../profile/index.ts"
import { type Command, panelCommands, panelTitle } from "./commands.ts"
import { openOverlay } from "./overlay.ts"
import { toggleRecording } from "./RecordControl.tsx"
import type { WorkspaceApi } from "./Workspace.tsx"
import { cameraId, isCamera, resetArrangement } from "./workspace.ts"

export interface CameraActions {
    addCamera: () => void
    /** the main camera (the one in the main view, else the first) shows this topic */
    showTopic: (key: string) => void
    /** an added camera panel goes away (camera 1 always stays) */
    removeCamera: (id: string) => void
}

export function useCommands(app: ViewerApp, api: WorkspaceApi, cameras: CameraActions): Command[] {
    const drive = useStore(app.drive.state)
    const recording = useStore(recorder.status)
    const view = useStore(app.settings)
    const connection = useStore(app.connection.status)
    const arm = app.profile.type === "arm"
    const focused = api.view.hide.length === 2
    const commands: Command[] = [
        {
            id: "drive.stop",
            label: "STOP: stop driving now",
            group: "Drive",
            keys: ["Space"],
            danger: true,
            words: "estop e-stop halt brake",
            run: () => (arm ? app.arm.stop() : app.drive.stop()),
        },
        {
            id: "drive.reconnect",
            label: "Reconnect the control link",
            group: "Drive",
            hint: drive.halt ? (drive.halt.reason === "lost" ? "disengaged: link lost" : "disengaged: latency over max") : undefined,
            blocked: drive.halt ? undefined : "driving isn't disengaged",
            run: () => app.reconnect(),
        },
        ...(arm ? [] : [{
            id: "drive.boost",
            label: drive.boost ? "Boost off" : "Boost on (faster)",
            group: "Drive" as const,
            keys: ["Shift"],
            run: () => app.drive.setBoost(!drive.boost),
        }]),
        ...app.profile.controls.filter((control) => control.kind === "button").map((control): Command => ({
            id: `robot.control.${control.id}`,
            label: `${app.profile.name}: ${control.label}`,
            group: "Robot",
            hint: control.topic,
            danger: true,
            run: () => app.drive.pressButton(control.id),
        })),
        { id: "drive.settings", label: "Drive speeds, topics and max latency", group: "Settings", hint: "Settings", words: "speed linear angular cmd_vel deadman", run: () => api.act("settings", "show") },
    ]
    for (const id of api.ids) {
        commands.push(...panelCommands(api.arrangement, id, panelTitle(id), { mobile: api.mobile }, (action) => api.act(id, action)))
        if (isCamera(id) && id !== cameraId(1)) {
            commands.push({ id: `panel.${id}.remove`, label: `${panelTitle(id)}: remove`, group: "Cameras", words: "close delete panel", run: () => cameras.removeCamera(id) })
        }
    }
    commands.push(
        { id: "layout.reset", label: "Reset the layout", group: "Layout", hint: "camera main, map + 3D left, status + settings right", words: "default arrangement panels restore", run: () => resetArrangement(api.ids) },
        { id: "layout.left", label: api.mobile ? "Open the left drawer" : api.view.hide.includes("left") ? "Show the left rail" : "Hide the left rail", group: "Layout", keys: ["["], run: () => api.toggleRail("left") },
        { id: "layout.right", label: api.mobile ? "Open the right drawer" : api.view.hide.includes("right") ? "Show the right rail" : "Hide the right rail", group: "Layout", keys: ["]"], run: () => api.toggleRail("right") },
        ...(api.mobile ? [] : [{ id: "layout.focus", label: focused ? "Show both rails" : "Focus the main view (hide both rails)", group: "Layout" as const, keys: ["\\"], run: api.toggleFocus }]),
        { id: "camera.add", label: "Add a camera panel", group: "Cameras", words: "new video image", run: cameras.addCamera },
        ...cameraTabs(connection.topics).map((tab): Command => ({
            id: `camera.topic.${tab.topic.key}`,
            label: `Camera: show ${tab.topic.name}`,
            group: "Cameras",
            hint: tab.depth ? "depth" : "video",
            run: () => cameras.showTopic(tab.topic.key),
        })),
        { id: "view.recenter", label: "3D view: follow the robot again", group: "View", words: "recenter center", run: () => app.recenter() },
        { id: "view.top", label: "3D view: top-down", group: "View", words: "bird overhead", run: () => app.topDown() },
        { id: "view.follow", label: view.follow ? "3D camera: stop following" : "3D camera: follow the robot", group: "View", run: () => app.settings.update({ follow: !view.follow }) },
        { id: "view.model", label: view.robotModel !== false ? "Hide the robot model" : "Show the robot model", group: "View", run: () => app.settings.update({ robotModel: view.robotModel === false }) },
        { id: "view.cube", label: view.viewCube ? "Hide the view cube" : "Show the view cube", group: "View", words: "orientation top front axes", run: () => app.settings.update({ viewCube: !view.viewCube }) },
        { id: "view.stats", label: view.showStats ? "Hide render stats" : "Show render stats", group: "View", words: "fps latency", run: () => app.settings.update({ showStats: !view.showStats }) },
        { id: "view.fullscreen", label: "Fullscreen window", group: "View", run: () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}) },
        {
            id: "record.toggle",
            label: recording.recording.active ? "Stop recording" : "Start recording",
            group: "Record",
            blocked: recording.unavailable ?? undefined,
            words: "mcap capture",
            run: () => void toggleRecording(app).catch(() => {}),
        },
        ...[{ type: "", name: "Auto" }, ...profiles].map((profile): Command => ({
            id: `robot.type.${profile.type || "auto"}`,
            label: `Controller format: ${profile.name}`,
            group: "Robot",
            hint: (view.profile || "") === profile.type ? "current" : undefined,
            words: "robot type profile keys model controls",
            run: () => app.settings.update({ profile: profile.type }),
        })),
        { id: "help.keys", label: "Keyboard shortcuts", group: "Help", keys: ["?"], words: "help keys bindings", run: () => openOverlay("help") },
    )
    return commands
}

