# dim-controller

Before changing the frontend (a panel, a 3D layer, a setting, the layout, phone vs desktop), read
[docs/changing_the_ui.md](docs/changing_the_ui.md).

## On a robot (Jetson, Raspberry Pi): don't build there

Never build this app on a robot's computer to try a change (no `nix build`, `cargo build`, `deno install`, `npm install`
or `uv sync` on it): it takes tens of minutes. Build on your own machine (cross compile; a debug build to iterate),
`rsync` the result over and hot-load it:
[how to compile for edge compute](https://github.com/jeff-hykin/dimos-desktop-mirror/blob/main/docs/create-apps/edge-compute.md).
