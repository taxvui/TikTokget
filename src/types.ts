export interface TikTokProfile {
  username: string;
  nickname: string;
  userId: string;
  secUid: string;
  avatarUrl: string;
  bio: string;
  bioLink?: string;
  verified: boolean;
  region?: string;
  followerCount: number;
  followingCount: number;
  heartCount: number;
  videoCount: number;
  profileUrl: string;
}

export interface TikTokVideoItem {
  id: string;
  url: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  mediaType?: 'video' | 'image';
  imageCount?: number | null;
  views: number | null;
  viewsFormatted: string;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  bookmarks: number | null;
  durationSec: number | null;
  createdAt: string | null;
  pinned: boolean;
  audioTitle?: string;
  source: 'ssr' | 'json-ld' | 'imported' | 'oembed';
  orderIndex: number;
}

export interface ResolvedPhotoImage {
  index: number;
  width: number | null;
  height: number | null;
  format: string;
  cdnUrl: string;
  proxyUrl: string;
  downloadUrl: string;
  sizeBytes: number | null;
}

export interface ScanResponse {
  profile: TikTokProfile;
  videos: TikTokVideoItem[];
  meta: {
    scannedCount: number;
    totalProfileCount: number;
    ssrLimited: boolean;
    sources: string[];
    scannedAt: string;
  };
}

export interface ImportResponse {
  videos: TikTokVideoItem[];
  parsedCount: number;
}

export interface ResolveVideoResponse {
  mediaType: 'video' | 'image';
  video: TikTokVideoItem;
  username: string;
  mp4DownloadUrl: string | null;
  mp4StreamUrl: string | null;
  mp4CdnUrl: string | null;
  fileSizeBytes: number | null;
  images: ResolvedPhotoImage[];
  zipDownloadUrl: string | null;
  audioCdnUrl?: string | null;
}
