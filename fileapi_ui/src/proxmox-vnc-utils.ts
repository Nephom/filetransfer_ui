export const hostSshProfileId = (entryId: string) => `vncjump:${entryId}`;

export const proxmoxHostFromBaseUrl = (baseUrl: string): string => {
  try { return new URL(baseUrl).hostname; } catch { return ""; }
};
