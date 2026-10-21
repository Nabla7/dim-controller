// Hand-written type for the vendored lcm_schemas.js: LCM type name → its fields in wire order.
declare const schemas: Record<string, { name: string; type: string; dims: (number | string)[] }[]>
export default schemas
