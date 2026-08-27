export type ShareResponse = {
  data?: {
    fullUrl?: string;
    shareUrl?: string;
    directDownloadUrl?: string;
    directDownloadFullUrl?: string;
  };
};

export type ShareLink = {
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
