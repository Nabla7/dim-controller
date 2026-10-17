// dimos.yaml's `provides: endpoints:` must list exactly the endpoints the server serves at agent.json (server/src/api.rs builds both
// the routes and agent.json from one table), so Desktop sees every endpoint even before the app runs.
// `deno task check-endpoints` (CI runs it on the nix-built binary: `--binary result/bin/dimos-app-server`);
// `--write` rewrites dimos.yaml's provides: when, description and endpoints; without it, they must match the server's.
import { parse, stringify } from "@std/yaml"

type Endpoint = { method: string; path: string }

const binaryAt = Deno.args.indexOf("--binary")
const command = binaryAt === -1
    ? new Deno.Command("cargo", {
        args: ["run", "-q", "--manifest-path", "server/Cargo.toml", "--", "--agent-json"],
        stderr: "inherit",
    })
    : new Deno.Command(Deno.args[binaryAt + 1], { args: ["--agent-json"], stderr: "inherit" })
const output = await command.output()
if (!output.success) {
    console.error("the server couldn't print its endpoints (--agent-json)")
    Deno.exit(1)
}
const served = JSON.parse(new TextDecoder().decode(output.stdout)) as {
    when: string
    description: string
    endpoints: (Endpoint & Record<string, unknown>)[]
}
// method and path first, so dimos.yaml reads well
const want = {
    when: served.when,
    description: served.description,
    endpoints: served.endpoints.map(({ method, path, when, description, params, role }) => ({
        method,
        path,
        when,
        description,
        ...(params ? { params } : {}),
        ...(role ? { role } : {}),
    })),
}

const file = new URL("../dimos.yaml", import.meta.url)
const yaml = parse(await Deno.readTextFile(file)) as Record<string, unknown>
if (Deno.args.includes("--write")) {
    // replace only `when:`, `description:` and `endpoints:` under `provides:`, so the rest of the file (and its comments) stays as written
    const lines = (await Deno.readTextFile(file)).split("\n")
    const block = stringify(want, { lineWidth: 116, indent: 4 }).trimEnd().split("\n").map((line) => `    ${line}`)
    const provides = lines.findIndex((line) => /^provides:/.test(line))
    if (provides === -1) {
        lines.splice(lines.length - (lines.at(-1) === "" ? 1 : 0), 0, "provides:", ...block)
    } else {
        let insertAt = -1
        for (const key of ["when", "description", "endpoints"]) {
            let end = provides + 1
            while (end < lines.length && !/^\S/.test(lines[end]) && !new RegExp(`^    ${key}:`).test(lines[end])) {
                end++
            }
            if (end < lines.length && /^ {4}\S/.test(lines[end])) {
                const start = end++
                while (end < lines.length && (lines[end] === "" || /^ {5}/.test(lines[end]))) {
                    end++
                }
                lines.splice(start, end - start)
                insertAt = insertAt === -1 ? start : Math.min(insertAt, start)
            }
        }
        if (insertAt === -1) {
            insertAt = provides + 1
            while (insertAt < lines.length && !/^\S/.test(lines[insertAt])) {
                insertAt++
            }
        }
        lines.splice(insertAt, 0, ...block)
    }
    await Deno.writeTextFile(file, lines.join("\n"))
    console.log(`wrote ${want.endpoints.length} endpoints into dimos.yaml`)
    Deno.exit(0)
}
const key = (e: Endpoint) => `${e.method} ${e.path}`
const have = new Set(((yaml.provides as { endpoints?: Endpoint[] })?.endpoints ?? []).map(key))
const need = new Set(want.endpoints.map(key))
const missing = [...need].filter((k) => !have.has(k))
const extra = [...have].filter((k) => !need.has(k))
if (missing.length || extra.length) {
    console.error(
        `dimos.yaml's provides: endpoints differ from the server's agent.json:\n  missing: ${
            missing.join(", ") || "-"
        }\n  extra: ${extra.join(", ") || "-"}\nrun: deno task check-endpoints --write`,
    )
    Deno.exit(1)
}
// the table is the source of truth for each endpoint's when, description and params too, not just its method and path
const sorted = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]),
        )
        : value
const provides = yaml.provides as Record<string, unknown>
const haveText = JSON.stringify(
    sorted({ when: provides.when, description: provides.description, endpoints: provides.endpoints }),
)
if (haveText !== JSON.stringify(sorted(want))) {
    console.error(
        "dimos.yaml's provides: when, description or endpoint details differ from the server's agent.json\nrun: deno task check-endpoints --write",
    )
    Deno.exit(1)
}
console.log(`dimos.yaml lists all ${need.size} endpoints`)
