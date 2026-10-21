// The depth image types, apart from depth.ts so the main entry's types don't pull in three (an optional peer).

/** A depth image's raw pixels: 16UC1 (millimeters) or 32FC1 (meters), row-major, one value per pixel. */
export type DepthPixels = Uint16Array | Float32Array

/** A depth image as camera streams deliver it. */
export interface DepthImage {
    width: number
    height: number
    encoding: string
    data: DepthPixels
}

/** How depth is colored: a colormap name and a fixed range in meters (null = automatic). */
export interface DepthLook {
    colormap: string
    near: number | null
    far: number | null
}
