// Use the companion dimos-lcm revision, including acquisition clock/epoch headers.
import { decodeLcm, encodeLcm, headerFrameId as legacyFrameId, lcmFingerprint, lcmSchemas } from "dimos-react"
import localSchemas from "./schemas.json" with { type: "json" }
Object.assign(lcmSchemas, localSchemas)
export { decodeLcm as decode, encodeLcm as encode, lcmFingerprint as fingerprint, lcmSchemas as schemas }
export function headerFrameId(type: string, bytes: Uint8Array): string | null {
    return localSchemas[type as keyof typeof localSchemas]?.some(field => field.name === "header" && field.type === "common_msgs.SampleHeader")
        ? decodeLcm(type, bytes).header.frame_id : legacyFrameId(type, bytes)
}
// deno-lint-ignore no-explicit-any
export type LcmValue = any
