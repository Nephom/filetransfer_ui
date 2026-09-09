export type ShareResponse = {
  data?: {
    hasPassword?: boolean;
    fullUrl?: string;
    shareUrl?: string;
    directDownloadUrl?: string;
    directDownloadFullUrl?: string;
  };
};

export type ShareLink = {
  hasPassword?: boolean;
  shareToken: string;
  userId?: number | string;
  creatorUsername?: string;
  fileName: string;
  locationId?: string;
  createdAt?: number;
  expiresAt?: number | null;
  maxDownloads: number;
  downloadCount: number;
  remainingDownloads?: number | null;
  isActive: boolean;
  isExpired?: boolean;
  isExhausted?: boolean;
  shareUrl?: string;
  directDownloadUrl?: string;
};
