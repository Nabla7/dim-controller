// LCM wire format: dimos-react's codec (its schemas are this app's schemas.json, made by tools/gen_lcm_schemas.ts).
export { decodeLcm as decode, encodeLcm as encode, headerFrameId, lcmFingerprint as fingerprint, lcmSchemas as schemas } from "dimos-react"

/** a decoded message (the schema's fields; nested messages are objects) */
// deno-lint-ignore no-explicit-any
export type LcmValue = any
