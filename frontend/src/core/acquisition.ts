// The sample's time is independent of gateway arrival time. Rendering uses milliseconds;
// epoch and clock remain separate so reset never joins two physical trajectories.
import { decode } from "./lcm/lcm.ts"
export interface AcquisitionHeader { clock_id: string; epoch: number; time_ns: number; frame_id: string }
export const acquisitionKey = (h: AcquisitionHeader) => `${h.clock_id}:${h.epoch}`
// A new publisher clock starts a new binding; delayed packets from a retired
// run or an earlier epoch cannot restore an obsolete scene.
export class AcquisitionOrder {
    #clock: string | undefined
    #epoch = -1
    #retired = new Set<string>()
    accept(h: AcquisitionHeader): boolean {
        if (this.#retired.has(h.clock_id)) return false
        if (this.#clock !== h.clock_id) {
            if (this.#clock !== undefined) this.#retired.add(this.#clock)
            this.#clock = h.clock_id
            this.#epoch = -1
        }
        if (h.epoch < this.#epoch) return false
        this.#epoch = h.epoch
        return true
    }
}
export const acquisitionMs = (h: AcquisitionHeader) => Number(h.time_ns) / 1e6

export function cloudFields(bytes: Uint8Array) {
    const m = decode("sensor_msgs.PointCloud2", bytes)
    const data: Uint8Array = m.data
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const fields = new Map<string, { offset: number; datatype: number }>(m.fields.map((f: { name: string; offset: number; datatype: number }) => [f.name, f]))
    const positions = new Float32Array(m.width * m.height * 3)
    const intensity = fields.has("intensity") ? new Uint8Array(m.width * m.height) : undefined
    const scalar = (offset: number, field: { offset: number; datatype: number }) => {
        const at = offset + field.offset, little = !m.is_bigendian
        switch (field.datatype) {
            case 7: return view.getFloat32(at, little)
            case 8: return view.getFloat64(at, little)
            case 2: return view.getUint8(at)
            case 4: return view.getUint16(at, little)
            default: throw new Error(`unsupported cloud scalar ${field.datatype}`)
        }
    }
    for (let row = 0; row < m.height; row++) for (let col = 0; col < m.width; col++) {
        const index = row * m.width + col, offset = row * m.row_step + col * m.point_step
        for (const [axis, name] of ["x", "y", "z"].entries()) {
            const field = fields.get(name)
            if (!field) throw new Error(`cloud has no ${name}`)
            positions[index * 3 + axis] = scalar(offset, field)
        }
        if (intensity) intensity[index] = Math.max(0, Math.min(255, scalar(offset, fields.get("intensity")!)))
    }
    return { positions, intensity, frameId: m.header.frame_id as string, acquisition: m.header as AcquisitionHeader }
}

export function imageFields(bytes: Uint8Array) {
    const m = decode("sensor_msgs.Image", bytes)
    return m as { header: AcquisitionHeader; width: number; height: number; step: number; encoding: string; is_bigendian: boolean; data: Uint8Array }
}
export function depthPixels(m: ReturnType<typeof imageFields>) {
    const pixels = m.width * m.height
    const data = m.encoding === "32FC1" ? new Float32Array(pixels) : m.encoding === "16UC1" ? new Uint16Array(pixels) : null
    if (!data) throw new Error(`unsupported depth encoding ${m.encoding}`)
    const view = new DataView(m.data.buffer, m.data.byteOffset, m.data.byteLength)
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
        const offset = y * m.step + x * data.BYTES_PER_ELEMENT
        data[y * m.width + x] = data instanceof Float32Array ? view.getFloat32(offset, !m.is_bigendian) : view.getUint16(offset, !m.is_bigendian)
    }
    return { width: m.width, height: m.height, encoding: m.encoding, data }
}
export function rgbPixels(m: ReturnType<typeof imageFields>): Uint8ClampedArray<ArrayBuffer> {
    if (!["rgb8", "bgr8", "rgba8", "bgra8", "mono8"].includes(m.encoding)) throw new Error(`unsupported color encoding ${m.encoding}`)
    const channels = m.encoding === "mono8" ? 1 : m.encoding.includes("a8") ? 4 : 3
    const swap = m.encoding.startsWith("bgr"), out = new Uint8ClampedArray(m.width * m.height * 4)
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
        const src = y * m.step + x * channels, dst = (y * m.width + x) * 4
        out[dst] = m.data[src + (swap ? 2 : 0)]
        out[dst+1] = m.data[src + (channels === 1 ? 0 : 1)]
        out[dst+2] = m.data[src + (channels === 1 || swap ? 0 : 2)]
        out[dst+3] = 255
    }
    return out
}
