import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import type {
  TikTokProfile,
  TikTokVideoItem,
  ScanResponse,
  ResolvedPhotoImage,
  ResolveVideoResponse,
} from './src/types.ts';
import { runNodriverStyleDeepScan } from './server/cdpScraper.ts';

const require = createRequire(import.meta.url);
const TiktokDL = require('@tobyg74/tiktok-api-dl') as {
  Downloader: (
    url: string,
    options?: { version?: 'v1' | 'v2' | 'v3'; showOriginalResponse?: boolean }
  ) => Promise<{
    status: string;
    message?: string;
    result?: {
      type?: 'video' | 'image' | 'music';
      id?: string;
      desc?: string;
      createTime?: number;
      author?: { uniqueId?: string; username?: string; nickname?: string };
      statistics?: {
        playCount?: number | string;
        likeCount?: number | string;
        commentCount?: number | string;
        shareCount?: number | string;
      };
      video?: {
        duration?: number;
        playAddr?: string[];
        downloadAddr?: string[];
      };
      videoHD?: string;
      videoSD?: string;
      images?: string[];
      music?: { title?: string; playUrl?: string[] };
    };
    resultNotParsed?: {
      content?: {
        aweme_id?: string;
        desc?: string;
        create_time?: number;
        author?: { unique_id?: string; nickname?: string };
        statistics?: {
          play_count?: number;
          digg_count?: number;
          comment_count?: number;
          share_count?: number;
          collect_count?: number;
        };
        music?: { title?: string; play_url?: { url_list?: string[] } };
        video?: { duration?: number; play_addr?: { url_list?: string[] }; download_addr?: { url_list?: string[] } };
        image_post_info?: {
          images?: Array<{
            display_image?: {
              url_list?: string[];
              width?: number;
              height?: number;
            };
            owner_watermark_image?: {
              url_list?: string[];
              width?: number;
              height?: number;
            };
            thumbnail?: {
              url_list?: string[];
              width?: number;
              height?: number;
            };
          }>;
        };
      };
    };
  }>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUsername(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  // Handle full URL like https://www.tiktok.com/@khanhlg204?lang=vi-VN
  const urlMatch = trimmed.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  // Handle @username or bare username
  const cleaned = trimmed.replace(/^@/, '').split(/[/?#\s]/)[0];
  if (/^[A-Za-z0-9._]{2,40}$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

function decodeSnowflakeTimestamp(videoId: string): string | null {
  try {
    if (!/^\d{15,22}$/.test(videoId)) return null;
    const tsSeconds = Number(BigInt(videoId) >> 32n);
    if (tsSeconds > 1400000000 && tsSeconds < 2500000000) {
      return new Date(tsSeconds * 1000).toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

function parseCompactCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.trim().toUpperCase().replace(/,/g, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const suffix = match[2];
  if (suffix === 'K') return Math.round(num * 1_000);
  if (suffix === 'M') return Math.round(num * 1_000_000);
  if (suffix === 'B') return Math.round(num * 1_000_000_000);
  return Math.round(num);
}

function formatCompactCount(num: number | null): string {
  if (num === null || Number.isNaN(num)) return '—';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(num);
}

function parseIsoDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  const total = h * 3600 + min * 60 + s;
  return total > 0 ? total : null;
}

const avatarUrlCache = new Map<string, string>();
const videoContentUrlCache = new Map<string, string>();
const photoImagesCache = new Map<string, { username: string; images: ResolvedPhotoImage[] }>();

function buildZipBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = zlib.crc32(entry.data) >>> 0;
    const size = entry.data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(0, 8); // Store (uncompressed lossless images)
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += 30 + nameBuf.length + size;
  }

  const centralDir = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDir.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, endRecord]);
}

function detectImageExtension(url: string, contentType?: string | null): string {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return 'jpg';
  if (ct.includes('image/png')) return 'png';
  if (ct.includes('image/webp')) return 'webp';
  if (ct.includes('image/avif')) return 'avif';
  if (ct.includes('image/heic') || ct.includes('image/heif')) return 'heic';
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'png';
  if (clean.endsWith('.webp')) return 'webp';
  if (clean.endsWith('.heic')) return 'heic';
  return 'jpg';
}

function pickBestImageUrl(urlList: string[] | undefined): string {
  if (!Array.isArray(urlList) || urlList.length === 0) return '';
  const valid = urlList.filter((u) => typeof u === 'string' && u.startsWith('http'));
  if (valid.length === 0) return '';

  const scoreUrl = (u: string): number => {
    const low = u.toLowerCase();
    let score = 0;
    if (/tplv-photomode-image\.jpe?g|noop\.jpeg|\.jpe?g(\?|$)/i.test(low)) score += 100;
    else if (/\.png(\?|$)/i.test(low)) score += 90;
    else if (/\.webp(\?|$)/i.test(low)) score += 60;
    else if (/\.heic(\?|$)/i.test(low)) score -= 50;
    if (/shrink|crop|thumbnail|q50|q60/i.test(low)) score -= 40;
    if (/watermark/i.test(low)) score -= 30;
    return score;
  };

  return [...valid].sort((a, b) => scoreUrl(b) - scoreUrl(a))[0];
}

function buildProxiedThumb(videoId: string): string {
  return `/api/media/thumb/${encodeURIComponent(videoId)}`;
}

function buildProxiedAvatar(username: string, rawUrl: string): string {
  if (!rawUrl) return '';
  const key = username.toLowerCase();
  avatarUrlCache.set(key, rawUrl);
  return `/api/media/avatar/${encodeURIComponent(key)}`;
}

async function fetchProfileMobile(username: string): Promise<{
  profile: Partial<TikTokProfile>;
  cookieHeader: string;
}> {
  const url = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': MOBILE_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  const setCookies = res.headers.getSetCookie?.() || [];
  const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
  const html = await res.text();

  const match = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match?.[1]) {
    return { profile: {}, cookieHeader };
  }

  try {
    const json = JSON.parse(match[1]);
    const userDetail = json?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
    const u = userDetail?.userInfo?.user;
    const stats = userDetail?.userInfo?.stats;
    if (!u) {
      return { profile: {}, cookieHeader };
    }

    return {
      cookieHeader,
      profile: {
        username: u.uniqueId || username,
        nickname: u.nickname || username,
        userId: u.id || '',
        secUid: u.secUid || '',
        avatarUrl: u.avatarLarger
          ? buildProxiedAvatar(u.uniqueId || username, u.avatarLarger)
          : '',
        bio: u.signature || '',
        bioLink: u.bioLink?.link || '',
        verified: Boolean(u.verified),
        region: u.region || '',
        followerCount: Number(stats?.followerCount || 0),
        followingCount: Number(stats?.followingCount || 0),
        heartCount: Number(stats?.heartCount || stats?.heart || 0),
        videoCount: Number(stats?.videoCount || 0),
        profileUrl: `https://www.tiktok.com/@${u.uniqueId || username}`,
      },
    };
  } catch {
    return { profile: {}, cookieHeader };
  }
}

async function fetchProfileSsr(username: string): Promise<{
  profileFallback: Partial<TikTokProfile>;
  videos: TikTokVideoItem[];
}> {
  const url = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': BOT_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  if (!res.ok) {
    throw new Error(`TikTok trả về mã lỗi HTTP ${res.status}`);
  }

  const html = await res.text();
  let profileFallback: Partial<TikTokProfile> = {};

  // Parse ProfilePage JSON-LD
  const profileLdMatch = html.match(
    /<script[^>]*id="ProfilePage"[^>]*>([\s\S]*?)<\/script>/
  );
  if (profileLdMatch?.[1]) {
    try {
      const ld = JSON.parse(profileLdMatch[1]);
      const main = ld?.mainEntity;
      if (main) {
        let likes = 0;
        let followers = 0;
        for (const stat of main.interactionStatistic || []) {
          const type = String(stat?.interactionType?.['@type'] || '');
          if (type.includes('LikeAction')) likes = Number(stat.userInteractionCount || 0);
          if (type.includes('FollowAction')) followers = Number(stat.userInteractionCount || 0);
        }
        profileFallback = {
          username: main.alternateName || main.identifier || username,
          nickname: main.name || username,
          bio: main.description || '',
          avatarUrl: main.image
            ? buildProxiedAvatar(main.alternateName || main.identifier || username, main.image)
            : '',
          bioLink: Array.isArray(main.sameAs) ? main.sameAs[0] || '' : '',
          followerCount: followers,
          heartCount: likes,
          profileUrl: main.url || `https://www.tiktok.com/@${username}`,
        };
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  // Parse ItemList JSON-LD (rich metrics for initial videos/photos)
  const jsonLdMap = new Map<string, Record<string, unknown>>();
  const itemListMatch = html.match(
    /<script[^>]*id="ItemList"[^>]*>([\s\S]*?)<\/script>/
  );
  if (itemListMatch?.[1]) {
    try {
      const itemList = JSON.parse(itemListMatch[1]);
      for (const entry of itemList?.itemListElement || []) {
        const videoId = String(entry?.url || '').match(/\/(?:video|photo)\/(\d+)/)?.[1];
        if (videoId) {
          jsonLdMap.set(videoId, entry);
        }
      }
    } catch {
      // Ignore malformed ItemList
    }
  }

  // Extract all video & photo anchor elements in SSR HTML
  const anchorRegex =
    /<a[^>]+href="(https:\/\/www\.tiktok\.com\/@[^/"]+\/(video|photo)\/(\d+))"[^>]*>([\s\S]*?)<\/a>/g;
  const seenIds = new Set<string>();
  const videos: TikTokVideoItem[] = [];

  for (const match of html.matchAll(anchorRegex)) {
    const videoUrl = match[1];
    const kind = match[2].toLowerCase();
    const videoId = match[3];
    const innerHtml = match[4];
    if (seenIds.has(videoId)) continue;
    seenIds.add(videoId);
    const isPhoto = kind === 'photo';

    const altRaw = innerHtml.match(/alt="([^"]*)"/)?.[1] || '';
    const altTitle = decodeHtmlEntities(altRaw).replace(/\s+do\s+.+?\s+tạo$/i, '');

    const textOnly = innerHtml
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const pinned = /Đã ghim|Pinned/i.test(textOnly);
    const viewToken = textOnly.match(/(\d+(?:[.,]\d+)?[KMB]?)/i)?.[1] || null;
    const parsedViewsFromDom = parseCompactCount(viewToken);

    const ld = jsonLdMap.get(videoId) as
      | {
          name?: string;
          description?: string;
          uploadDate?: string;
          contentUrl?: string;
          commentCount?: string | number;
          duration?: string;
          audio?: { name?: string };
          interactionStatistic?: Array<{
            interactionType?: { '@type'?: string };
            userInteractionCount?: number;
          }>;
        }
      | undefined;

    if (ld?.contentUrl) {
      videoContentUrlCache.set(videoId, ld.contentUrl);
    }

    let ldViews: number | null = null;
    let ldLikes: number | null = null;
    let ldSaves: number | null = null;
    let ldShares: number | null = null;

    if (ld?.interactionStatistic) {
      for (const st of ld.interactionStatistic) {
        const t = String(st?.interactionType?.['@type'] || '');
        const count = Number(st?.userInteractionCount);
        if (Number.isNaN(count)) continue;
        if (t.includes('WatchAction')) ldViews = count;
        else if (t.includes('LikeAction')) ldLikes = count;
        else if (t.includes('SaveAction')) ldSaves = count;
        else if (t.includes('ShareAction')) ldShares = count;
      }
    }

    const views = ldViews ?? parsedViewsFromDom;
    const rawName = ld?.name ? decodeHtmlEntities(ld.name).replace(/\s*\|\s*TikTok$/i, '') : '';
    const rawDesc = ld?.description ? decodeHtmlEntities(ld.description) : '';
    const title = rawName || altTitle || `${isPhoto ? 'Bộ ảnh' : 'Video'} #${videoId}`;
    const description = rawDesc || altTitle || title;

    videos.push({
      id: videoId,
      url: videoUrl,
      title,
      description,
      thumbnailUrl: buildProxiedThumb(videoId),
      mediaType: isPhoto ? 'image' : 'video',
      views,
      viewsFormatted: formatCompactCount(views),
      likes: ldLikes,
      comments: ld?.commentCount !== undefined ? Number(ld.commentCount) : null,
      shares: ldShares,
      bookmarks: ldSaves,
      durationSec: parseIsoDuration(ld?.duration),
      createdAt: ld?.uploadDate || decodeSnowflakeTimestamp(videoId),
      pinned,
      audioTitle: ld?.audio?.name ? decodeHtmlEntities(ld.audio.name) : undefined,
      source: ld ? 'json-ld' : 'ssr',
      orderIndex: videos.length + 1,
    });
  }

  return { profileFallback, videos };
}

function parseImportedItems(rawText: string, defaultUsername?: string): TikTokVideoItem[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  const resultMap = new Map<string, TikTokVideoItem>();

  // 1. Try JSON parse first (from Console Full-Channel Script or TikTok item_list dump)
  try {
    const parsed = JSON.parse(trimmed);
    const items: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.videos)
        ? parsed.videos
        : Array.isArray(parsed?.itemList)
          ? parsed.itemList
          : [];

    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;
      const rawItemUrl = String(obj.url || '');
      const id = String(
        obj.id ||
          obj.aweme_id ||
          rawItemUrl.match(/\/(?:video|photo)\/(\d+)/)?.[1] ||
          ''
      ).trim();
      if (!/^\d{10,24}$/.test(id)) continue;

      const authorObj = (obj.author && typeof obj.author === 'object'
        ? obj.author
        : {}) as Record<string, unknown>;
      const statsObj = (obj.stats && typeof obj.stats === 'object'
        ? obj.stats
        : {}) as Record<string, unknown>;
      const videoObj = (obj.video && typeof obj.video === 'object'
        ? obj.video
        : {}) as Record<string, unknown>;
      const musicObj = (obj.music && typeof obj.music === 'object'
        ? obj.music
        : {}) as Record<string, unknown>;
      const imagePostObj = (obj.imagePost && typeof obj.imagePost === 'object'
        ? obj.imagePost
        : null) as { images?: unknown[] } | null;

      const isPhoto =
        obj.mediaType === 'image' ||
        /\/photo\/\d+/i.test(rawItemUrl) ||
        Boolean(imagePostObj?.images?.length);
      const imageCount =
        typeof obj.imageCount === 'number'
          ? obj.imageCount
          : Array.isArray(imagePostObj?.images)
            ? imagePostObj.images.length
            : null;

      const uname = String(
        obj.username || authorObj.uniqueId || defaultUsername || 'user'
      ).replace(/^@/, '');
      const url = String(
        obj.url || `https://www.tiktok.com/@${uname}/${isPhoto ? 'photo' : 'video'}/${id}`
      );

      const viewsRaw =
        obj.views ?? statsObj.playCount ?? statsObj.play_count ?? null;
      const views = viewsRaw !== null && viewsRaw !== undefined ? Number(viewsRaw) : null;
      const likesRaw = obj.likes ?? statsObj.diggCount ?? statsObj.digg_count ?? null;
      const commentsRaw =
        obj.comments ?? statsObj.commentCount ?? statsObj.comment_count ?? null;
      const sharesRaw =
        obj.shares ?? statsObj.shareCount ?? statsObj.share_count ?? null;
      const bookmarksRaw =
        obj.bookmarks ?? statsObj.collectCount ?? statsObj.collect_count ?? null;
      const durationRaw = obj.durationSec ?? videoObj.duration ?? null;

      let createdAt: string | null = null;
      if (typeof obj.createdAt === 'string') {
        createdAt = obj.createdAt;
      } else if (obj.createTime) {
        createdAt = new Date(Number(obj.createTime) * 1000).toISOString();
      } else {
        createdAt = decodeSnowflakeTimestamp(id);
      }

      const desc = String(obj.description || obj.desc || obj.title || '').trim();
      resultMap.set(id, {
        id,
        url,
        title: String(obj.title || desc || `${isPhoto ? 'Bộ ảnh' : 'Video'} #${id}`),
        description: desc || `${isPhoto ? 'Bộ ảnh' : 'Video'} #${id}`,
        thumbnailUrl: buildProxiedThumb(id),
        mediaType: isPhoto ? 'image' : 'video',
        imageCount,
        views: views !== null && !Number.isNaN(views) ? views : null,
        viewsFormatted: formatCompactCount(
          views !== null && !Number.isNaN(views) ? views : null
        ),
        likes: likesRaw !== null && !Number.isNaN(Number(likesRaw)) ? Number(likesRaw) : null,
        comments:
          commentsRaw !== null && !Number.isNaN(Number(commentsRaw))
            ? Number(commentsRaw)
            : null,
        shares: sharesRaw !== null && !Number.isNaN(Number(sharesRaw)) ? Number(sharesRaw) : null,
        bookmarks:
          bookmarksRaw !== null && !Number.isNaN(Number(bookmarksRaw))
            ? Number(bookmarksRaw)
            : null,
        durationSec:
          durationRaw !== null && !Number.isNaN(Number(durationRaw))
            ? Number(durationRaw)
            : null,
        createdAt,
        pinned: Boolean(obj.pinned || obj.isPinnedItem),
        audioTitle:
          typeof obj.audioTitle === 'string'
            ? obj.audioTitle
            : typeof musicObj.title === 'string'
              ? musicObj.title
              : undefined,
        source: 'imported',
        orderIndex: resultMap.size + 1,
      });
    }
  } catch {
    // Not JSON — fall back to HTML / URL / Video ID regex extraction
  }

  // 2. Extract any TikTok video or photo URLs from HTML or plain text
  if (resultMap.size === 0) {
    const fullUrlMatches = trimmed.matchAll(
      /https?:\/\/(?:www\.|m\.)?tiktok\.com\/@([A-Za-z0-9._]+)\/(video|photo)\/(\d+)/gi
    );
    for (const m of fullUrlMatches) {
      const uname = m[1];
      const kind = m[2].toLowerCase();
      const id = m[3];
      const isPhoto = kind === 'photo';
      if (!resultMap.has(id)) {
        resultMap.set(id, {
          id,
          url: `https://www.tiktok.com/@${uname}/${kind}/${id}`,
          title: `${isPhoto ? 'Bộ ảnh' : 'Video'} #${id}`,
          description: `${isPhoto ? 'Bộ ảnh' : 'Video'} @${uname} #${id}`,
          thumbnailUrl: buildProxiedThumb(id),
          mediaType: isPhoto ? 'image' : 'video',
          views: null,
          viewsFormatted: '—',
          likes: null,
          comments: null,
          shares: null,
          bookmarks: null,
          durationSec: null,
          createdAt: decodeSnowflakeTimestamp(id),
          pinned: false,
          source: 'imported',
          orderIndex: resultMap.size + 1,
        });
      }
    }

    // Also match bare video IDs (19-digit numbers) if user pasted ID list
    if (resultMap.size === 0 && defaultUsername) {
      const bareIds = trimmed.matchAll(/\b(7\d{18})\b/g);
      for (const m of bareIds) {
        const id = m[1];
        if (!resultMap.has(id)) {
          resultMap.set(id, {
            id,
            url: `https://www.tiktok.com/@${defaultUsername}/video/${id}`,
            title: `Video #${id}`,
            description: `Video @${defaultUsername} #${id}`,
            thumbnailUrl: buildProxiedThumb(id),
            mediaType: 'video',
            views: null,
            viewsFormatted: '—',
            likes: null,
            comments: null,
            shares: null,
            bookmarks: null,
            durationSec: null,
            createdAt: decodeSnowflakeTimestamp(id),
            pinned: false,
            source: 'imported',
            orderIndex: resultMap.size + 1,
          });
        }
      }
    }
  }

  return Array.from(resultMap.values());
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.post('/api/scan', async (req, res) => {
    try {
      const target = String(req.body?.target || '').trim();
      const username = normalizeUsername(target);

      if (!username) {
        res.status(400).json({
          error:
            'Liên kết hoặc tên tài khoản TikTok không hợp lệ. Ví dụ: https://www.tiktok.com/@khanhlg204 hoặc @khanhlg204.',
        });
        return;
      }

      const [mobileResult, ssrResult] = await Promise.all([
        fetchProfileMobile(username).catch(() => ({
          profile: {} as Partial<TikTokProfile>,
          cookieHeader: '',
        })),
        fetchProfileSsr(username),
      ]);

      const mergedProfile: TikTokProfile = {
        username: mobileResult.profile.username || ssrResult.profileFallback.username || username,
        nickname:
          mobileResult.profile.nickname || ssrResult.profileFallback.nickname || `@${username}`,
        userId: mobileResult.profile.userId || '',
        secUid: mobileResult.profile.secUid || '',
        avatarUrl:
          mobileResult.profile.avatarUrl || ssrResult.profileFallback.avatarUrl || '',
        bio: mobileResult.profile.bio || ssrResult.profileFallback.bio || '',
        bioLink:
          mobileResult.profile.bioLink || ssrResult.profileFallback.bioLink || '',
        verified: Boolean(mobileResult.profile.verified),
        region: mobileResult.profile.region || '',
        followerCount:
          mobileResult.profile.followerCount ??
          ssrResult.profileFallback.followerCount ??
          0,
        followingCount: mobileResult.profile.followingCount ?? 0,
        heartCount:
          mobileResult.profile.heartCount ?? ssrResult.profileFallback.heartCount ?? 0,
        videoCount:
          mobileResult.profile.videoCount || ssrResult.videos.length,
        profileUrl: `https://www.tiktok.com/@${mobileResult.profile.username || username}`,
      };

      const totalCount = mergedProfile.videoCount || ssrResult.videos.length;
      const responsePayload: ScanResponse = {
        profile: mergedProfile,
        videos: ssrResult.videos,
        meta: {
          scannedCount: ssrResult.videos.length,
          totalProfileCount: totalCount,
          ssrLimited: totalCount > ssrResult.videos.length,
          sources: ['TikTok Mobile Rehydration', 'TikTok SSR HTML & ItemList JSON-LD'],
          scannedAt: new Date().toISOString(),
        },
      };

      res.json(responsePayload);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Không thể kết nối đến TikTok lúc này.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/deep-scan', async (req, res) => {
    const target = String(req.body?.target || req.body?.username || '').trim();
    const username = normalizeUsername(target);

    if (!username) {
      res.status(400).json({
        error: 'Tên tài khoản hoặc link kênh TikTok không hợp lệ.',
      });
      return;
    }

    const cookie = typeof req.body?.cookie === 'string' ? req.body.cookie : undefined;
    const proxy = typeof req.body?.proxy === 'string' ? req.body.proxy : undefined;
    const maxRounds =
      typeof req.body?.maxRounds === 'number' && req.body.maxRounds > 0
        ? Math.min(200, Math.round(req.body.maxRounds))
        : 120;

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        abortController.abort();
      }
    });

    const writeEvent = (ev: unknown) => {
      if (!res.writableEnded && !abortController.signal.aborted) {
        res.write(`${JSON.stringify(ev)}\n`);
      }
    };

    try {
      await runNodriverStyleDeepScan({
        username,
        cookie,
        proxy,
        maxRounds,
        signal: abortController.signal,
        onEvent: writeEvent,
      });
    } catch (err) {
      writeEvent({
        type: 'error',
        error:
          err instanceof Error
            ? err.message
            : 'Lỗi khi chạy trình cào Chrome CDP tự động.',
      });
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  app.post('/api/import', (req, res) => {
    try {
      const rawText = String(req.body?.rawText || '');
      const username = normalizeUsername(String(req.body?.username || '')) || undefined;
      const videos = parseImportedItems(rawText, username);

      if (videos.length === 0) {
        res.status(400).json({
          error:
            'Không tìm thấy link video TikTok hoặc JSON hợp lệ trong dữ liệu đã dán.',
        });
        return;
      }

      res.json({ videos, parsedCount: videos.length });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Lỗi phân tích dữ liệu nhập vào.',
      });
    }
  });

  app.post('/api/enrich', async (req, res) => {
    try {
      const urls = Array.isArray(req.body?.urls)
        ? (req.body.urls as unknown[]).map(String).slice(0, 20)
        : [];
      const enriched: Array<{
        id: string;
        title?: string;
        authorName?: string;
      }> = [];

      await Promise.all(
        urls.map(async (u) => {
          const id = u.match(/\/video\/(\d+)/)?.[1];
          if (!id) return;
          try {
            const r = await fetch(
              `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`
            );
            if (!r.ok) return;
            const data = (await r.json()) as {
              title?: string;
              author_name?: string;
            };
            enriched.push({
              id,
              title: data.title,
              authorName: data.author_name,
            });
          } catch {
            // Skip failed oEmbed
          }
        })
      );

      res.json({ enriched });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Lỗi bổ sung thông tin video.',
      });
    }
  });

  async function resolveTikTokMedia(rawUrl: string): Promise<ResolveVideoResponse> {
    let targetUrl = rawUrl.trim();
    if (!targetUrl) {
      throw new Error('Vui lòng nhập đường dẫn video hoặc bộ ảnh TikTok.');
    }

    // Resolve short links (vt.tiktok.com, vm.tiktok.com, tiktok.com/t/...)
    if (/vt\.tiktok\.com|vm\.tiktok\.com|tiktok\.com\/t\//i.test(targetUrl)) {
      const headRes = await fetch(targetUrl, {
        headers: { 'User-Agent': BOT_UA },
        redirect: 'follow',
      });
      if (headRes.url) {
        targetUrl = headRes.url.split('?')[0];
      }
    }

    const match = targetUrl.match(/tiktok\.com\/@([^/?#]+)\/(video|photo)\/(\d+)/i);
    const idOnlyMatch =
      targetUrl.match(/\/(?:video|photo)\/(\d+)/i) || targetUrl.match(/^(\d{15,22})$/);
    const itemId = match?.[3] || idOnlyMatch?.[1];
    let username = match?.[1] || 'tiktok';
    const hintedKind = match?.[2]?.toLowerCase() === 'photo' ? 'photo' : 'video';

    if (!itemId) {
      throw new Error(
        'Không nhận diện được ID bài đăng TikTok. Ví dụ: https://www.tiktok.com/@khanhlg204/video/... hoặc .../photo/...'
      );
    }

    const canonicalUrl = `https://www.tiktok.com/@${username}/${hintedKind}/${itemId}`;

    // Query TikTok API v1 (returns both video & image_post_info at original resolution) + BOT SSR HTML in parallel
    const [v1Res, pageRes] = await Promise.all([
      TiktokDL.Downloader(canonicalUrl, {
        version: 'v1',
        showOriginalResponse: true,
      }).catch(() => null),
      fetch(canonicalUrl, {
        headers: {
          'User-Agent': BOT_UA,
          'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
        },
      }).catch(() => null),
    ]);

    const rawContent = v1Res?.status === 'success' ? v1Res.resultNotParsed?.content : undefined;
    if (rawContent?.author?.unique_id) {
      username = rawContent.author.unique_id;
    }

    let title = rawContent?.desc ? decodeHtmlEntities(rawContent.desc) : '';
    let description = title;
    let contentUrl = videoContentUrlCache.get(itemId) || '';
    let views: number | null =
      rawContent?.statistics?.play_count !== undefined
        ? Number(rawContent.statistics.play_count)
        : null;
    let likes: number | null =
      rawContent?.statistics?.digg_count !== undefined
        ? Number(rawContent.statistics.digg_count)
        : null;
    let shares: number | null =
      rawContent?.statistics?.share_count !== undefined
        ? Number(rawContent.statistics.share_count)
        : null;
    let bookmarks: number | null =
      rawContent?.statistics?.collect_count !== undefined
        ? Number(rawContent.statistics.collect_count)
        : null;
    let comments: number | null =
      rawContent?.statistics?.comment_count !== undefined
        ? Number(rawContent.statistics.comment_count)
        : null;
    let durationSec: number | null =
      rawContent?.video?.duration && rawContent.video.duration > 0
        ? Math.round(rawContent.video.duration / (rawContent.video.duration > 600 ? 1000 : 1))
        : null;
    let createdAt = rawContent?.create_time
      ? new Date(Number(rawContent.create_time) * 1000).toISOString()
      : decodeSnowflakeTimestamp(itemId);
    let audioTitle: string | undefined = rawContent?.music?.title
      ? decodeHtmlEntities(rawContent.music.title)
      : undefined;
    const audioCdnUrl = rawContent?.music?.play_url?.url_list?.[0] || null;

    if (pageRes?.ok) {
      const html = await pageRes.text();
      const vdoMatch = html.match(/<script[^>]*id="VideoObject"[^>]*>([\s\S]*?)<\/script>/);
      if (vdoMatch?.[1]) {
        try {
          const vdo = JSON.parse(vdoMatch[1]) as {
            name?: string;
            description?: string;
            uploadDate?: string;
            contentUrl?: string;
            commentCount?: string | number;
            duration?: string;
            audio?: { name?: string };
            interactionStatistic?: Array<{
              interactionType?: { '@type'?: string };
              userInteractionCount?: number;
            }>;
          };

          if (vdo.contentUrl) {
            contentUrl = vdo.contentUrl;
            videoContentUrlCache.set(itemId, contentUrl);
          }
          if (!title && vdo.name) {
            title = decodeHtmlEntities(vdo.name).replace(/\s*\|\s*TikTok$/i, '');
          }
          if (!description && vdo.description) {
            description = decodeHtmlEntities(vdo.description);
          }
          if (vdo.uploadDate) createdAt = vdo.uploadDate;
          if (comments === null && vdo.commentCount !== undefined) {
            comments = Number(vdo.commentCount);
          }
          if (!durationSec) durationSec = parseIsoDuration(vdo.duration);
          if (!audioTitle && vdo.audio?.name) audioTitle = decodeHtmlEntities(vdo.audio.name);

          for (const st of vdo.interactionStatistic || []) {
            const t = String(st?.interactionType?.['@type'] || '');
            const count = Number(st?.userInteractionCount);
            if (Number.isNaN(count)) continue;
            if (views === null && t.includes('WatchAction')) views = count;
            else if (likes === null && t.includes('LikeAction')) likes = count;
            else if (bookmarks === null && t.includes('SaveAction')) bookmarks = count;
            else if (shares === null && t.includes('ShareAction')) shares = count;
          }
        } catch {
          // Ignore malformed JSON-LD
        }
      }
    }

    // 1. Check if this post is a TikTok Photo Carousel / Slideshow
    let rawImageEntries: Array<{
      cdnUrl: string;
      width: number | null;
      height: number | null;
    }> = [];

    if (rawContent?.image_post_info?.images?.length) {
      rawImageEntries = rawContent.image_post_info.images
        .map((img) => {
          const disp = img.display_image || img.owner_watermark_image || img.thumbnail;
          const cdnUrl = pickBestImageUrl(disp?.url_list);
          if (!cdnUrl) return null;
          return {
            cdnUrl,
            width: typeof disp?.width === 'number' ? disp.width : null,
            height: typeof disp?.height === 'number' ? disp.height : null,
          };
        })
        .filter((x): x is { cdnUrl: string; width: number | null; height: number | null } => Boolean(x));
    }

    // Fallback to v2 (SSSTik) or v3 (MusicalDown) if v1 missed image_post_info or if URL was /photo/
    if (rawImageEntries.length === 0 && (hintedKind === 'photo' || !contentUrl)) {
      for (const ver of ['v2', 'v3'] as const) {
        const fb = await TiktokDL.Downloader(canonicalUrl, { version: ver }).catch(() => null);
        if (fb?.status === 'success' && fb.result?.type === 'image' && fb.result.images?.length) {
          rawImageEntries = fb.result.images.map((u) => ({
            cdnUrl: u,
            width: null,
            height: null,
          }));
          if (!title && fb.result.desc) title = decodeHtmlEntities(fb.result.desc);
          if (!description && fb.result.desc) description = decodeHtmlEntities(fb.result.desc);
          break;
        }
        if (
          !contentUrl &&
          fb?.status === 'success' &&
          fb.result?.type === 'video'
        ) {
          const fbVideoUrl =
            fb.result.videoHD ||
            fb.result.video?.playAddr?.[0] ||
            fb.result.video?.downloadAddr?.[0] ||
            fb.result.videoSD ||
            '';
          if (fbVideoUrl) {
            contentUrl = fbVideoUrl;
            videoContentUrlCache.set(itemId, contentUrl);
          }
          if (!title && fb.result.desc) title = decodeHtmlEntities(fb.result.desc);
          break;
        }
      }
    }

    if (rawImageEntries.length > 0) {
      // Probe Content-Type and byte size of each highest-resolution image
      const resolvedImages: ResolvedPhotoImage[] = await Promise.all(
        rawImageEntries.map(async (entry, i) => {
          const idx = i + 1;
          let format = detectImageExtension(entry.cdnUrl);
          let sizeBytes: number | null = null;
          try {
            const probe = await fetch(entry.cdnUrl, {
              headers: { 'User-Agent': BOT_UA, 'Referer': 'https://www.tiktok.com/', Range: 'bytes=0-0' },
            }).catch(() => null);
            if (probe) {
              format = detectImageExtension(entry.cdnUrl, probe.headers.get('content-type'));
              const cr = probe.headers.get('content-range');
              const totalMatch = cr?.match(/\/(\d+)$/);
              if (totalMatch?.[1]) {
                sizeBytes = Number(totalMatch[1]);
              } else {
                const cl = probe.headers.get('content-length');
                if (cl && !Number.isNaN(Number(cl)) && probe.status === 200) {
                  sizeBytes = Number(cl);
                }
              }
            }
          } catch {
            // Skip probe failure
          }

          const proxyUrl = `/api/media/photo/${encodeURIComponent(itemId)}/${idx}?u=${encodeURIComponent(
            username
          )}`;
          return {
            index: idx,
            width: entry.width,
            height: entry.height,
            format,
            cdnUrl: entry.cdnUrl,
            proxyUrl,
            downloadUrl: `${proxyUrl}&download=1`,
            sizeBytes,
          };
        })
      );

      photoImagesCache.set(itemId, { username, images: resolvedImages });
      const totalSize = resolvedImages.reduce((acc, img) => acc + (img.sizeBytes || 0), 0);
      const photoUrl = `https://www.tiktok.com/@${username}/photo/${itemId}`;
      const displayTitle = title || `Bộ ảnh #${itemId}`;

      return {
        mediaType: 'image',
        username,
        mp4DownloadUrl: null,
        mp4StreamUrl: null,
        mp4CdnUrl: null,
        fileSizeBytes: totalSize > 0 ? totalSize : null,
        images: resolvedImages,
        zipDownloadUrl: `/api/media/photo-zip/${encodeURIComponent(itemId)}?u=${encodeURIComponent(
          username
        )}`,
        audioCdnUrl,
        video: {
          id: itemId,
          url: photoUrl,
          title: displayTitle,
          description: description || displayTitle,
          thumbnailUrl: resolvedImages[0]?.proxyUrl || buildProxiedThumb(itemId),
          mediaType: 'image',
          imageCount: resolvedImages.length,
          views,
          viewsFormatted: formatCompactCount(views),
          likes,
          comments,
          shares,
          bookmarks,
          durationSec: null,
          createdAt,
          pinned: false,
          audioTitle,
          source: 'json-ld',
          orderIndex: 1,
        },
      };
    }

    // 2. Video (.MP4) fallback from v1 aweme/v1/feed if VideoObject had no contentUrl
    if (!contentUrl && rawContent?.video) {
      contentUrl =
        rawContent.video.play_addr?.url_list?.[0] ||
        rawContent.video.download_addr?.url_list?.[0] ||
        '';
      if (contentUrl) {
        videoContentUrlCache.set(itemId, contentUrl);
      }
    }

    let mp4CdnUrl: string | null = null;
    let fileSizeBytes: number | null = null;

    if (contentUrl) {
      try {
        const redirectRes = await fetch(contentUrl, {
          headers: { 'User-Agent': BOT_UA, 'Referer': 'https://www.tiktok.com/' },
          redirect: 'manual',
        });
        const loc = redirectRes.headers.get('location') || contentUrl;
        if (loc) {
          mp4CdnUrl = loc;
          const rangeRes = await fetch(loc, {
            headers: { 'User-Agent': BOT_UA, 'Referer': 'https://www.tiktok.com/', Range: 'bytes=0-0' },
          }).catch(() => null);
          const cr = rangeRes?.headers.get('content-range');
          const totalMatch = cr?.match(/\/(\d+)$/);
          if (totalMatch?.[1]) {
            fileSizeBytes = Number(totalMatch[1]);
          }
        }
      } catch {
        // Fallback to first-party proxy
      }
    }

    if (!contentUrl) {
      throw new Error(
        'Không tìm thấy luồng video MP4 hoặc bộ ảnh cho liên kết này (bài đăng có thể ở chế độ riêng tư hoặc đã bị xoá).'
      );
    }

    const mp4StreamUrl = `/api/media/video/${encodeURIComponent(itemId)}?u=${encodeURIComponent(
      username
    )}`;
    const mp4DownloadUrl = `${mp4StreamUrl}&download=1`;
    const videoUrl = `https://www.tiktok.com/@${username}/video/${itemId}`;
    const displayTitle = title || `Video #${itemId}`;

    return {
      mediaType: 'video',
      username,
      mp4DownloadUrl,
      mp4StreamUrl,
      mp4CdnUrl,
      fileSizeBytes,
      images: [],
      zipDownloadUrl: null,
      audioCdnUrl,
      video: {
        id: itemId,
        url: videoUrl,
        title: displayTitle,
        description: description || displayTitle,
        thumbnailUrl: buildProxiedThumb(itemId),
        mediaType: 'video',
        views,
        viewsFormatted: formatCompactCount(views),
        likes,
        comments,
        shares,
        bookmarks,
        durationSec,
        createdAt,
        pinned: false,
        audioTitle,
        source: 'json-ld',
        orderIndex: 1,
      },
    };
  }

  app.post(['/api/resolve-video', '/api/resolve-media'], async (req, res) => {
    try {
      const url = String(req.body?.url || '').trim();
      const result = await resolveTikTokMedia(url);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Không thể trích xuất media từ liên kết này.',
      });
    }
  });

  app.post('/api/resolve-mp4-batch', async (req, res) => {
    try {
      const urls = Array.isArray(req.body?.urls)
        ? (req.body.urls as unknown[]).map(String).slice(0, 12)
        : [];
      const results: Array<{
        id: string;
        url: string;
        mediaType: 'video' | 'image';
        mp4CdnUrl: string | null;
        mp4DownloadUrl: string | null;
        imageUrls: string[];
        zipDownloadUrl: string | null;
        fileSizeBytes: number | null;
      }> = [];

      await Promise.all(
        urls.map(async (u) => {
          try {
            const resolved = await resolveTikTokMedia(u);
            results.push({
              id: resolved.video.id,
              url: resolved.video.url,
              mediaType: resolved.mediaType,
              mp4CdnUrl: resolved.mp4CdnUrl,
              mp4DownloadUrl: resolved.mp4DownloadUrl,
              imageUrls: resolved.images.map((img) => img.cdnUrl),
              zipDownloadUrl: resolved.zipDownloadUrl,
              fileSizeBytes: resolved.fileSizeBytes,
            });
          } catch {
            // Skip unavailable items in batch
          }
        })
      );

      res.json({ results });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Lỗi trích xuất danh sách media.',
      });
    }
  });

  app.get('/api/media/photo/:id/:index', async (req, res) => {
    try {
      const itemId = String(req.params.id || '').trim();
      const index = Number(req.params.index);
      const username = normalizeUsername(String(req.query.u || '')) || 'tiktok';
      const isDownload = req.query.download === '1';

      if (!/^\d{10,24}$/.test(itemId) || !Number.isInteger(index) || index < 1) {
        res.status(400).send('Invalid photo reference');
        return;
      }

      let cached = photoImagesCache.get(itemId);
      if (!cached) {
        await resolveTikTokMedia(`https://www.tiktok.com/@${username}/photo/${itemId}`);
        cached = photoImagesCache.get(itemId);
      }

      const photo = cached?.images.find((img) => img.index === index);
      if (!photo) {
        res.status(404).send('Photo not found');
        return;
      }

      const upstream = await fetch(photo.cdnUrl, {
        headers: {
          'User-Agent': BOT_UA,
          'Referer': 'https://www.tiktok.com/',
        },
      });
      if (!upstream.ok) {
        res.status(upstream.status).send('Upstream photo unavailable');
        return;
      }

      const ct = upstream.headers.get('content-type') || 'image/jpeg';
      const ext = detectImageExtension(photo.cdnUrl, ct);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      if (isDownload) {
        const padded = String(index).padStart(2, '0');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="tiktok_${itemId}_anh_${padded}.${ext}"`
        );
      }
      res.send(buf);
    } catch {
      res.status(502).send('Photo proxy error');
    }
  });

  app.get('/api/media/photo-zip/:id', async (req, res) => {
    try {
      const itemId = String(req.params.id || '').trim();
      const username = normalizeUsername(String(req.query.u || '')) || 'tiktok';
      if (!/^\d{10,24}$/.test(itemId)) {
        res.status(400).send('Invalid post id');
        return;
      }

      let cached = photoImagesCache.get(itemId);
      if (!cached) {
        const resolved = await resolveTikTokMedia(
          `https://www.tiktok.com/@${username}/photo/${itemId}`
        );
        if (resolved.mediaType !== 'image' || resolved.images.length === 0) {
          res.status(400).send('Bài đăng này không phải dạng bộ ảnh.');
          return;
        }
        cached = photoImagesCache.get(itemId);
      }

      if (!cached || cached.images.length === 0) {
        res.status(404).send('Không tìm thấy ảnh nào để nén .ZIP.');
        return;
      }

      const fetchedEntries = await Promise.all(
        cached.images.map(async (img) => {
          const upstream = await fetch(img.cdnUrl, {
            headers: {
              'User-Agent': BOT_UA,
              'Referer': 'https://www.tiktok.com/',
            },
          });
          if (!upstream.ok) return null;
          const ct = upstream.headers.get('content-type');
          const ext = detectImageExtension(img.cdnUrl, ct);
          const data = Buffer.from(await upstream.arrayBuffer());
          const padded = String(img.index).padStart(2, '0');
          const resTag = img.width && img.height ? `_${img.width}x${img.height}` : '';
          return {
            name: `${padded}${resTag}.${ext}`,
            data,
          };
        })
      );

      const validEntries: Array<{ name: string; data: Buffer }> = [];
      for (const item of fetchedEntries) {
        if (item && item.data.length > 0) {
          validEntries.push(item);
        }
      }
      if (validEntries.length === 0) {
        res.status(502).send('Không thể tải ảnh gốc từ máy chủ TikTok.');
        return;
      }

      const manifest = cached.images.map((img) => img.cdnUrl).join('\n');
      validEntries.push({
        name: 'links_anh_goc.txt',
        data: Buffer.from(manifest, 'utf8'),
      });

      const zipBuf = buildZipBuffer(validEntries);
      const safeUser = (cached.username || username).replace(/[^a-z0-9._-]/gi, '_');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(zipBuf.length));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="tiktok_${safeUser}_${itemId}_${cached.images.length}_anh.zip"`
      );
      res.send(zipBuf);
    } catch (err) {
      res.status(500).send(
        err instanceof Error ? err.message : 'Lỗi nén bộ ảnh thành tệp .ZIP.'
      );
    }
  });

  app.post('/api/media/photos-zip-batch', async (req, res) => {
    try {
      const urls = Array.isArray(req.body?.urls)
        ? (req.body.urls as unknown[]).map(String).slice(0, 15)
        : [];
      if (urls.length === 0) {
        res.status(400).json({ error: 'Vui lòng chọn ít nhất một bài đăng.' });
        return;
      }

      const entries: Array<{ name: string; data: Buffer }> = [];
      const allLinks: string[] = [];

      for (const rawUrl of urls) {
        try {
          const resolved = await resolveTikTokMedia(rawUrl);
          if (resolved.mediaType !== 'image' || resolved.images.length === 0) continue;

          const folder = `${resolved.username}_${resolved.video.id}`;
          const downloaded = await Promise.all(
            resolved.images.map(async (img) => {
              const upstream = await fetch(img.cdnUrl, {
                headers: { 'User-Agent': BOT_UA, 'Referer': 'https://www.tiktok.com/' },
              }).catch(() => null);
              if (!upstream || !upstream.ok) return null;
              const ext = detectImageExtension(img.cdnUrl, upstream.headers.get('content-type'));
              const data = Buffer.from(await upstream.arrayBuffer());
              const padded = String(img.index).padStart(2, '0');
              return { name: `${folder}/${padded}.${ext}`, data };
            })
          );

          for (const item of downloaded) {
            if (item && item.data.length > 0) entries.push(item);
          }
          for (const img of resolved.images) {
            allLinks.push(img.cdnUrl);
          }
        } catch {
          // Skip unavailable items
        }
      }

      if (entries.length === 0) {
        res.status(400).json({
          error: 'Không có bài đăng dạng bộ ảnh nào trong các mục đã chọn.',
        });
        return;
      }

      entries.push({
        name: 'tat_ca_link_anh.txt',
        data: Buffer.from(allLinks.join('\n'), 'utf8'),
      });

      const zipBuf = buildZipBuffer(entries);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(zipBuf.length));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="tiktok_bo_anh_${entries.length - 1}_file.zip"`
      );
      res.send(zipBuf);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Lỗi nén hàng loạt ảnh .ZIP.',
      });
    }
  });

  app.get('/api/media/thumb/:id', async (req, res) => {
    try {
      const itemId = String(req.params.id || '').trim();
      if (!/^\d{10,24}$/.test(itemId)) {
        res.status(400).send('Invalid item id');
        return;
      }

      const targetUrl = `https://www.tiktok.com/api/img/?itemId=${itemId}&location=0&aid=1988`;
      const upstream = await fetch(targetUrl, {
        headers: {
          'User-Agent': BOT_UA,
          'Referer': 'https://www.tiktok.com/',
        },
      });

      if (!upstream.ok) {
        res.status(upstream.status).send('Thumbnail unavailable');
        return;
      }

      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(buf);
    } catch {
      res.status(502).send('Thumbnail proxy error');
    }
  });

  app.get('/api/media/avatar/:username', async (req, res) => {
    try {
      const key = String(req.params.username || '').trim().toLowerCase();
      let targetUrl = avatarUrlCache.get(key) || '';

      if (!targetUrl && /^[a-z0-9._]{2,40}$/i.test(key)) {
        const mob = await fetchProfileMobile(key).catch(() => null);
        if (mob) {
          targetUrl = avatarUrlCache.get(key) || '';
        }
      }

      if (!targetUrl) {
        res.status(404).send('Avatar not found');
        return;
      }

      const upstream = await fetch(targetUrl, {
        headers: {
          'User-Agent': BOT_UA,
          'Referer': 'https://www.tiktok.com/',
        },
      });

      if (!upstream.ok) {
        res.status(upstream.status).send('Avatar unavailable');
        return;
      }

      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(buf);
    } catch {
      res.status(502).send('Avatar proxy error');
    }
  });

  app.get('/api/media/video/:id', async (req, res) => {
    try {
      const itemId = String(req.params.id || '').trim();
      const username = normalizeUsername(String(req.query.u || '')) || 'tiktok';
      const isDownload = req.query.download === '1';

      if (!/^\d{10,24}$/.test(itemId)) {
        res.status(400).send('Invalid video id');
        return;
      }

      let contentUrl = videoContentUrlCache.get(itemId) || '';
      if (!contentUrl) {
        const pageUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${itemId}`;
        const pageRes = await fetch(pageUrl, {
          headers: {
            'User-Agent': BOT_UA,
            'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
          },
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          const vdoMatch = html.match(
            /<script[^>]*id="VideoObject"[^>]*>([\s\S]*?)<\/script>/
          );
          if (vdoMatch?.[1]) {
            try {
              const vdo = JSON.parse(vdoMatch[1]) as { contentUrl?: string };
              if (vdo.contentUrl) {
                contentUrl = vdo.contentUrl;
                videoContentUrlCache.set(itemId, contentUrl);
              }
            } catch {
              // Ignore malformed JSON-LD
            }
          }
        }
      }

      if (!contentUrl) {
        res.status(404).send('Video stream unavailable');
        return;
      }

      const headers: Record<string, string> = {
        'User-Agent': BOT_UA,
        'Referer': 'https://www.tiktok.com/',
      };
      if (req.headers.range && !isDownload) {
        headers['Range'] = String(req.headers.range);
      }

      const upstream = await fetch(contentUrl, { headers });
      if (!upstream.ok && upstream.status !== 206) {
        res.status(upstream.status).send('Upstream video unavailable');
        return;
      }

      res.status(upstream.status);
      const ct = upstream.headers.get('content-type') || 'video/mp4';
      const cl = upstream.headers.get('content-length');
      const cr = upstream.headers.get('content-range');
      const ar = upstream.headers.get('accept-ranges') || 'bytes';

      res.setHeader('Content-Type', ct);
      res.setHeader('Accept-Ranges', ar);
      if (cl) res.setHeader('Content-Length', cl);
      if (cr) res.setHeader('Content-Range', cr);
      if (isDownload) {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="tiktok_${itemId}.mp4"`
        );
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch {
      res.status(502).send('Video proxy error');
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: { server: httpServer },
        hmr: process.env.DISABLE_HMR === 'true' ? false : true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
  });
}

startServer();
