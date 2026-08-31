// The shape of one entry returned by GET /api/locations. Shared between
// main.tsx (still owns most of the REMOTE file browser, pending the full
// Phase 5 refactor -- see GitHub issue #229) and this feature's own
// useRemoteApiActions hook, which owns the small REMOTE/API connection
// slice pulled out ahead of schedule while fixing issue #233 (token
// refresh).
export type RemoteLocation = {
  id: string;
  displayName: string;
  status?: string;
  readOnly?: boolean;
  capabilities?: string[];
};
