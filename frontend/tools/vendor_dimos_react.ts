// Vendors dimos-react (github.com/jeff-hykin/dimos-react) into src/vendor/dimos-react at a tag, so the page builds
// offline (nix) from its TypeScript source like the rest of src/:
//   deno task vendor-dimos-react v0.2.5
// dimos-react is Deno-only source with relative, extension-ful imports and bare react / three imports, which resolve to
// this page's own (deno.json's imports, node_modules for Vite). Its tests, demo and tools aren't copied.
import $ from "jsr:@david/dax@0.43.2"

const tag = Deno.args[0]
if (!tag) {
    throw new Error("usage: deno task vendor-dimos-react <tag, e.g. v0.2.5>")
}
const target = $.path(new URL("../src/vendor/dimos-react", import.meta.url))
const scratch = $.path(await Deno.makeTempDir())
await $`git clone --quiet --depth 1 --branch ${tag} https://github.com/jeff-hykin/dimos-react ${scratch}`
const commit = (await $`git -C ${scratch} rev-parse HEAD`.text()).trim()
await target.remove({ recursive: true }).catch(() => {})
await target.mkdir({ recursive: true })
await $`cp -R ${scratch.join("src")} ${target.join("src")}`
await scratch.join("LICENSE").copyFile(target.join("LICENSE"))
await target.join("VERSION").writeText(`jeff-hykin/dimos-react ${tag} ${commit}\n`)
await scratch.remove({ recursive: true })
console.log(`src/vendor/dimos-react = dimos-react ${tag} (${commit})`)
