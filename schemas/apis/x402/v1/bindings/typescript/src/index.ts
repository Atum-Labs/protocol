// Generated types are exported from here.
export * from "./extra";
export * from "./payload";
// request.ts inlines AtumEscrowExtra (via the $ref), so re-export only the request
// type to avoid a duplicate AtumEscrowExtra export (canonical one comes from ./extra).
export type { AtumEscrowRequest } from "./request";
