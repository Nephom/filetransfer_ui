import type { SshProfile } from "../ssh/ssh-contracts";
import type { RemoteLocation } from "./remote-browser-contracts";
import { useEffect, useRef } from "react";

// Minimal structural shape of main.tsx's ApiResponse, matching exactly
// what this hook calls on it -- avoids importing main.tsx's own
// (unexported) ApiResponse class just for its type. Mirrors the same
// pattern already used by useShareLinksActions.ts.
type ApiLikeResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

type ManagedSessionLike = { sshEntries: SshProfile[] };
type SshTabLike = { sshEntryId: string; connected: boolean };

// Generic over the caller's full Session shape (main.tsx's own `Session`
// type isn't exported), so this hook only needs to know that whatever
// `SessionLike` is, it has a `locationId` field -- and can pass the
// caller's real `setSession` dispatcher straight through untouched.
export type UseRemoteApiActionsParams<SessionLike extends { locationId: string; locationRevision?: string }> = {
  api: (endpoint: string, init?: RequestInit) => Promise<ApiLikeResponse>;
  readError: (response: ApiLikeResponse) => Promise<string>;
  session: SessionLike;
  setSession: (updater: (current: SessionLike) => SessionLike) => void;
  remoteSshEntryId: string;
  managedSessions: ManagedSessionLike[];
  sshTabs: SshTabLike[];
  locations: RemoteLocation[];
  setLocations: (locations: RemoteLocation[]) => void;
  setLocationsLoading: (loading: boolean) => void;
  locationsLoadedRef: { current: boolean };
  locationRefreshInProgressRef: { current: boolean };
  sessionIdentity: string;
  onLocationInvalidated: () => void;
};

// Owns the small slice of the REMOTE (API Location / SSH) file browser
// that is purely about *which* remote endpoint the app talks to and
// whether the app is actually connected to it -- as opposed to the much
// larger slice (folder tree, sorting, search, breadcrumbs, grid/table
// JSX) that GitHub issue #229 (Phase 5 of the main.tsx refactor) still
// has to extract. This smaller piece was pulled out ahead of schedule
// while fixing issue #233 (token refresh), because `loadLocations` is one
// of the functions that calls `api()`, and #233's fix lives inside
// `api()` -- keeping this call site in main.tsx next to a growing set of
// other REMOTE-connection functions would have made the eventual full
// Phase 5 extraction harder, not easier.
export function useRemoteApiActions<SessionLike extends { locationId: string; locationRevision?: string }>({
  api, readError, session, setSession, remoteSshEntryId,
  managedSessions, sshTabs, locations, setLocations, setLocationsLoading,
  locationsLoadedRef, locationRefreshInProgressRef,
  sessionIdentity, onLocationInvalidated,
}: UseRemoteApiActionsParams<SessionLike>) {
  const latest = useRef({ sessionIdentity, session, onLocationInvalidated });
  latest.current = { sessionIdentity, session, onLocationInvalidated };
  const mounted = useRef(true);
  const request = useRef(0);
  const identity = useRef(sessionIdentity);
  if (identity.current !== sessionIdentity) {
    identity.current = sessionIdentity;
    request.current++;
    locationRefreshInProgressRef.current = false;
    locationsLoadedRef.current = false;
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  const activeLocation = locations.find(
    (location) => location.id === session.locationId,
  );
  const hasCapability = (capability: string) =>
    activeLocation?.capabilities?.includes(capability) === true;
  const locationOnline = activeLocation?.status === "online";

  const loadLocations = async () => {
    if (locationRefreshInProgressRef.current) return;
    locationRefreshInProgressRef.current = true;
    const generation = ++request.current;
    const isCurrent = () => mounted.current && generation === request.current && latest.current.sessionIdentity === sessionIdentity;
    if (!locationsLoadedRef.current) setLocationsLoading(true);
    try {
      const response = await api("/api/locations");
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { locations?: RemoteLocation[] };
      if (!isCurrent()) return;
      const available = (data.locations || []).filter(
        (location) => location.id,
      );
      locationsLoadedRef.current = true;
      const currentLocation = latest.current.session;
      const replacement = available.find((location) => location.id === currentLocation.locationId) || available[0];
      if (currentLocation.locationId !== (replacement?.id || "") || currentLocation.locationRevision !== replacement?.revision) {
        latest.current.onLocationInvalidated();
      }
      setLocations(available);
      setSession((current) => {
        if (!isCurrent()) return current;
        const location = available.find((item) => item.id === current.locationId) || available[0];
        return { ...current, locationId: location?.id || "", locationRevision: location?.revision };
      });
    } catch (error) {
      if (isCurrent()) throw error;
    } finally {
      if (generation === request.current) locationRefreshInProgressRef.current = false;
      if (isCurrent()) setLocationsLoading(false);
    }
  };

  const findSshProfileById = (entryId: string): SshProfile | undefined =>
    managedSessions.flatMap((workspace) => workspace.sshEntries).find((entry) => entry.id === entryId);

  const ensureApiRemote = () => {
    if (remoteSshEntryId) {
      throw new Error("This action is not available while browsing an SSH remote. Switch LOCATION back to an API Remote first.");
    }
  };

  const connectedSshBrowseOptions = () =>
    managedSessions
      .flatMap((workspace) => workspace.sshEntries)
      .filter((entry) => sshTabs.some((tab) => tab.sshEntryId === entry.id && tab.connected));

  return {
    activeLocation, hasCapability, locationOnline,
    loadLocations, findSshProfileById, ensureApiRemote, connectedSshBrowseOptions,
  };
}
