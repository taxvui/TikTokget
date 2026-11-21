import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type { TikTokVideoItem } from '../src/types.ts';

const require = createRequire(import.meta.url);

export interface DeepScanEvent {
  type: 'status' | 'items' | 'complete' | 'error';
  phase?: 'launching' | 'navigating' | 'scrolling' | 'done';
  message?: string;
  videos?: TikTokVideoItem[];
  collected?: number;
  batches?: number;
  stopReason?: 'completed' | 'guest_limit' | 'aborted' | 'stalled';
}

export interface DeepScanOptions {
  username: string;
  cookie?: string;
  proxy?: string;
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent: (ev: DeepScanEvent) => void;
}

interface CdpCookieParam {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

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

export function parseTikTokCookies(rawInput: string | undefined): CdpCookieParam[] {
  const raw = (rawInput || '').trim();
  if (!raw) return [];

  const cookies: CdpCookieParam[] = [];

  // 1. JSON array format (e.g., Cookie-Editor / EditThisCookie)
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cookies)
          ? parsed.cookies
          : [];
      for (const c of arr) {
        if (!c || typeof c !== 'object') continue;
        const name = String(c.name || '').trim();
        const value = String(c.value ?? '');
        if (!name) continue;
        cookies.push({
          name,
          value,
          domain: String(c.domain || '.tiktok.com'),
          path: String(c.path || '/'),
          secure: c.secure !== undefined ? Boolean(c.secure) : true,
          httpOnly: c.httpOnly !== undefined ? Boolean(c.httpOnly) : false,
          ...(typeof c.expirationDate === 'number' && c.expirationDate > 0
            ? { expires: c.expirationDate }
            : {}),
        });
      }
      if (cookies.length > 0) return cookies;
    } catch {
      // Fall through to Netscape / Header formats
    }
  }

  // 2. Netscape cookies.txt format (tab-separated lines)
  const lines = raw.split(/\r?\n/);
  let matchedNetscape = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    if (parts.length >= 7) {
      matchedNetscape = true;
      const [domain, , cookiePath, secureFlag, expiresStr, name, ...valParts] = parts;
      const value = valParts.join('\t');
      if (name) {
        const exp = Number(expiresStr);
        cookies.push({
          name: name.trim(),
          value,
          domain: domain.trim() || '.tiktok.com',
          path: cookiePath.trim() || '/',
          secure: secureFlag.toUpperCase() === 'TRUE',
          ...(Number.isFinite(exp) && exp > 0 ? { expires: exp } : {}),
        });
      }
    }
  }
  if (matchedNetscape && cookies.length > 0) return cookies;

  // 3. Standard HTTP Cookie header string ("sessionid=...; ttwid=...; msToken=...")
  const cleanedHeader = raw.replace(/^cookie:\s*/i, '');
  for (const pair of cleanedHeader.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (!name) continue;
    cookies.push({
      name,
      value,
      domain: '.tiktok.com',
      path: '/',
      secure: true,
    });
  }

  return cookies;
}

export function parseProxyInput(rawProxy: string | undefined): {
  serverArg: string;
  username?: string;
  password?: string;
} | null {
  const raw = (rawProxy || '').trim();
  if (!raw) return null;

  // Support host:port:user:pass shorthand
  if (!raw.includes('://')) {
    const colonParts = raw.split(':');
    if (colonParts.length === 4) {
      const [host, port, username, password] = colonParts;
      return { serverArg: `http://${host}:${port}`, username, password };
    }
    if (colonParts.length === 2) {
      return { serverArg: `http://${raw}` };
    }
  }

  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const serverArg = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    return { serverArg, username, password };
  } catch {
    return null;
  }
}

async function resolveChromeExecutable(): Promise<string> {
  try {
    const puppeteer = require('puppeteer') as {
      executablePath: () => string | Promise<string>;
    };
    const resolved = await puppeteer.executablePath();
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // Fallback to system paths
  }

  const candidates = [
    process.env.CHROME_PATH || '',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error('Không tìm thấy trình duyệt Chrome/Chromium trên máy chủ để chạy CDP.');
}

function mapApiItemToVideo(
  raw: Record<string, unknown>,
  fallbackUsername: string,
  orderIndex: number
): TikTokVideoItem | null {
  const id = String(raw.id || raw.aweme_id || '').trim();
  if (!/^\d{10,24}$/.test(id)) return null;

  const authorObj = (raw.author && typeof raw.author === 'object'
    ? raw.author
    : {}) as Record<string, unknown>;
  const statsObj = (raw.stats && typeof raw.stats === 'object'
    ? raw.stats
    : {}) as Record<string, unknown>;
  const videoObj = (raw.video && typeof raw.video === 'object'
    ? raw.video
    : {}) as Record<string, unknown>;
  const musicObj = (raw.music && typeof raw.music === 'object'
    ? raw.music
    : {}) as Record<string, unknown>;
  const imagePostObj = (raw.imagePost && typeof raw.imagePost === 'object'
    ? raw.imagePost
    : null) as { images?: unknown[] } | null;

  const isPhoto = Boolean(imagePostObj?.images?.length);
  const imageCount = isPhoto ? imagePostObj!.images!.length : null;
  const uname = String(authorObj.uniqueId || fallbackUsername).replace(/^@/, '');
  const url = `https://www.tiktok.com/@${uname}/${isPhoto ? 'photo' : 'video'}/${id}`;
  const desc = String(raw.desc || '').trim();

  const viewsRaw = statsObj.playCount ?? null;
  const views = viewsRaw !== null && !Number.isNaN(Number(viewsRaw)) ? Number(viewsRaw) : null;
  const likesRaw = statsObj.diggCount ?? null;
  const commentsRaw = statsObj.commentCount ?? null;
  const sharesRaw = statsObj.shareCount ?? null;
  const bookmarksRaw = statsObj.collectCount ?? null;
  const durationRaw = videoObj.duration ?? null;

  const createdAt = raw.createTime
    ? new Date(Number(raw.createTime) * 1000).toISOString()
    : decodeSnowflakeTimestamp(id);

  return {
    id,
    url,
    title: desc || `${isPhoto ? 'Bộ ảnh' : 'Video'} #${id}`,
    description: desc || `${isPhoto ? 'Bộ ảnh' : 'Video'} @${uname} #${id}`,
    thumbnailUrl: `/api/media/thumb/${encodeURIComponent(id)}`,
    mediaType: isPhoto ? 'image' : 'video',
    imageCount,
    views,
    viewsFormatted: formatCompactCount(views),
    likes: likesRaw !== null && !Number.isNaN(Number(likesRaw)) ? Number(likesRaw) : null,
    comments:
      commentsRaw !== null && !Number.isNaN(Number(commentsRaw)) ? Number(commentsRaw) : null,
    shares: sharesRaw !== null && !Number.isNaN(Number(sharesRaw)) ? Number(sharesRaw) : null,
    bookmarks:
      bookmarksRaw !== null && !Number.isNaN(Number(bookmarksRaw))
        ? Number(bookmarksRaw)
        : null,
    durationSec:
      durationRaw !== null && !Number.isNaN(Number(durationRaw)) && Number(durationRaw) > 0
        ? Number(durationRaw)
        : null,
    createdAt,
    pinned: Boolean(raw.isPinnedItem),
    audioTitle: typeof musicObj.title === 'string' ? musicObj.title : undefined,
    source: 'imported',
    orderIndex,
  };
}

function parseAnchorOuterHtml(
  outerHtml: string,
  fallbackUsername: string,
  orderIndex: number
): TikTokVideoItem | null {
  const hrefMatch = outerHtml.match(
    /href="https?:\/\/(?:www\.|m\.)?tiktok\.com\/@([^/"]+)\/(video|photo)\/(\d+)/i
  );
  if (!hrefMatch) return null;

  const uname = hrefMatch[1] || fallbackUsername;
  const kind = hrefMatch[2].toLowerCase() === 'photo' ? 'photo' : 'video';
  const id = hrefMatch[3];
  const isPhoto = kind === 'photo';

  const altRaw = outerHtml.match(/alt="([^"]*)"/)?.[1] || '';
  const altTitle = decodeHtmlEntities(altRaw).replace(/\s+do\s+.+?\s+tạo$/i, '');

  const textOnly = outerHtml
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const pinned = /Đã ghim|Pinned/i.test(textOnly);
  const viewToken = textOnly.match(/(\d+(?:[.,]\d+)?[KMB]?)/i)?.[1] || null;
  const views = parseCompactCount(viewToken);

  return {
    id,
    url: `https://www.tiktok.com/@${uname}/${kind}/${id}`,
    title: altTitle || `${isPhoto ? 'Bộ ảnh' : 'Video'} #${id}`,
    description: altTitle || `${isPhoto ? 'Bộ ảnh' : 'Video'} @${uname} #${id}`,
    thumbnailUrl: `/api/media/thumb/${encodeURIComponent(id)}`,
    mediaType: isPhoto ? 'image' : 'video',
    views,
    viewsFormatted: formatCompactCount(views),
    likes: null,
    comments: null,
    shares: null,
    bookmarks: null,
    durationSec: null,
    createdAt: decodeSnowflakeTimestamp(id),
    pinned,
    source: 'ssr',
    orderIndex,
  };
}

export async function runNodriverStyleDeepScan(opts: DeepScanOptions): Promise<void> {
  const { username, cookie, proxy, maxRounds = 120, signal, onEvent } = opts;
  const userDataDir = path.join('/tmp', `tiklink_cdp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const chromeExe = await resolveChromeExecutable();
  const parsedCookies = parseTikTokCookies(cookie);
  const parsedProxy = parseProxyInput(proxy);

  onEvent({
    type: 'status',
    phase: 'launching',
    message: 'Đang khởi chạy Chrome CDP thuần (không bật Runtime.enable)...',
    collected: 0,
    batches: 0,
  });

  const chromeArgs = [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--window-size=1366,900',
    '--lang=vi-VN,vi',
  ];

  if (parsedProxy?.serverArg) {
    chromeArgs.push(`--proxy-server=${parsedProxy.serverArg}`);
  }
  chromeArgs.push('about:blank');

  const proc = spawn(chromeExe, chromeArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });

  let ws: WebSocket | null = null;

  const cleanup = () => {
    try {
      ws?.close();
    } catch {
      // Ignore close error
    }
    try {
      if (proc.pid) {
        process.kill(-proc.pid, 'SIGKILL');
      } else {
        proc.kill('SIGKILL');
      }
    } catch {
      // Ignore kill error
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Ignore fs cleanup error
    }
  };

  if (signal) {
    signal.addEventListener('abort', cleanup, { once: true });
  }

  try {
    const browserWsUrl = await new Promise<string>((resolve, reject) => {
      let stderrBuf = '';
      const timer = setTimeout(() => {
        reject(new Error('Hết thời gian chờ khởi chạy trình duyệt Chrome CDP.'));
      }, 12000);

      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome thoát bất ngờ (mã ${code ?? 'unknown'}).`));
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m?.[1]) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });

    if (signal?.aborted) {
      onEvent({
        type: 'complete',
        stopReason: 'aborted',
        collected: 0,
        message: 'Đã dừng quét theo yêu cầu.',
      });
      return;
    }

    const debugPort = new URL(browserWsUrl).port;
    const targets = (await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) =>
      r.json()
    )) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
    const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error('Không tìm thấy tab CDP để điều khiển.');
    }

    const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
    ws = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kết nối WebSocket CDP thất bại.')), 8000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Lỗi WebSocket CDP.'));
      });
    });

    let cmdId = 1;
    const pendingCallbacks = new Map<
      number,
      { resolve: (val: unknown) => void; reject: (err: Error) => void }
    >();

    const call = <T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error('CDP socket đã đóng.'));
          return;
        }
        const id = cmdId++;
        const timer = setTimeout(() => {
          pendingCallbacks.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 12000);

        pendingCallbacks.set(id, {
          resolve: (val) => {
            clearTimeout(timer);
            resolve(val as T);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    };

    const collectedMap = new Map<string, TikTokVideoItem>();
    const pendingItemListReqIds = new Set<string>();
    let batchCount = 0;
    let emptyApiResponses = 0;
    let sawHasMoreFalse = false;
    let lastItemAddedAt = Date.now();

    socket.addEventListener('message', async (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          result?: unknown;
          error?: { message?: string };
        };

        if (msg.id !== undefined) {
          const cb = pendingCallbacks.get(msg.id);
          if (cb) {
            pendingCallbacks.delete(msg.id);
            if (msg.error) cb.reject(new Error(msg.error.message || 'CDP error'));
            else cb.resolve(msg.result);
          }
          return;
        }

        if (msg.method === 'Fetch.requestPaused') {
          const reqId = String(msg.params?.requestId || '');
          if (reqId) {
            void call('Fetch.continueRequest', { requestId: reqId }).catch(() => {});
          }
          return;
        }

        if (msg.method === 'Fetch.authRequired' && parsedProxy?.username) {
          const reqId = String(msg.params?.requestId || '');
          if (reqId) {
            void call('Fetch.continueWithAuth', {
              requestId: reqId,
              authChallengeResponse: {
                response: 'ProvideCredentials',
                username: parsedProxy.username,
                password: parsedProxy.password || '',
              },
            }).catch(() => {});
          }
          return;
        }

        if (msg.method === 'Network.responseReceived') {
          const response = msg.params?.response as { url?: string } | undefined;
          const reqId = String(msg.params?.requestId || '');
          if (response?.url?.includes('/api/post/item_list') && reqId) {
            pendingItemListReqIds.add(reqId);
          }
          return;
        }

        if (msg.method === 'Network.loadingFinished') {
          const reqId = String(msg.params?.requestId || '');
          if (!pendingItemListReqIds.has(reqId)) return;
          pendingItemListReqIds.delete(reqId);

          const bodyRes = await call<{ body?: string; base64Encoded?: boolean }>(
            'Network.getResponseBody',
            { requestId: reqId }
          ).catch(() => null);

          if (!bodyRes?.body) {
            emptyApiResponses++;
            return;
          }

          const rawText = bodyRes.base64Encoded
            ? Buffer.from(bodyRes.body, 'base64').toString('utf8')
            : bodyRes.body;

          if (!rawText.trim()) {
            emptyApiResponses++;
            return;
          }

          try {
            const json = JSON.parse(rawText) as {
              itemList?: Array<Record<string, unknown>>;
              hasMore?: boolean;
            };
            const list = Array.isArray(json.itemList) ? json.itemList : [];
            if (list.length === 0) {
              emptyApiResponses++;
              return;
            }

            emptyApiResponses = 0;
            batchCount++;
            if (json.hasMore === false) {
              sawHasMoreFalse = true;
            }

            const newBatch: TikTokVideoItem[] = [];
            for (const rawItem of list) {
              const mapped = mapApiItemToVideo(rawItem, username, collectedMap.size + 1);
              if (!mapped) continue;
              if (!collectedMap.has(mapped.id)) {
                collectedMap.set(mapped.id, mapped);
                newBatch.push(mapped);
              }
            }

            if (newBatch.length > 0) {
              lastItemAddedAt = Date.now();
              onEvent({
                type: 'items',
                videos: newBatch,
                collected: collectedMap.size,
              });
              onEvent({
                type: 'status',
                phase: 'scrolling',
                message: `Đang cuộn & bắt API: đã thu thập ${collectedMap.size} bài đăng (${batchCount} gói dữ liệu)...`,
                collected: collectedMap.size,
                batches: batchCount,
              });
            }
          } catch {
            emptyApiResponses++;
          }
        }
      } catch {
        // Ignore malformed CDP message
      }
    });

    // Enable Network ONLY (NO Runtime.enable / Page.enable to preserve Nodriver-style stealth!)
    await call('Network.enable');

    if (parsedProxy?.username) {
      await call('Fetch.enable', { handleAuthRequests: true });
    }

    if (parsedCookies.length > 0) {
      await call('Network.setCookies', { cookies: parsedCookies });
    }

    const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
    onEvent({
      type: 'status',
      phase: 'navigating',
      message: `Đang mở trang @${username} bằng Chrome CDP${
        parsedCookies.length > 0 ? ` (${parsedCookies.length} cookie)` : ''
      }...`,
      collected: 0,
      batches: 0,
    });

    await call('Page.navigate', { url: profileUrl });
    await new Promise((r) => setTimeout(r, 4500));

    const extractDomAnchors = async () => {
      try {
        const doc = await call<{ root?: { nodeId?: number } }>('DOM.getDocument', { depth: 1 });
        const rootId = doc?.root?.nodeId;
        if (!rootId) return 0;

        const q = await call<{ nodeIds?: number[] }>('DOM.querySelectorAll', {
          nodeId: rootId,
          selector: 'a[href*="/video/"], a[href*="/photo/"]',
        });

        const nodeIds = q?.nodeIds || [];
        const domNewItems: TikTokVideoItem[] = [];

        for (const nid of nodeIds) {
          if (signal?.aborted) break;
          const htmlRes = await call<{ outerHTML?: string }>('DOM.getOuterHTML', {
            nodeId: nid,
          }).catch(() => null);
          if (!htmlRes?.outerHTML) continue;
          const item = parseAnchorOuterHtml(
            htmlRes.outerHTML,
            username,
            collectedMap.size + 1
          );
          if (item && !collectedMap.has(item.id)) {
            collectedMap.set(item.id, item);
            domNewItems.push(item);
          }
        }

        if (domNewItems.length > 0) {
          lastItemAddedAt = Date.now();
          onEvent({
            type: 'items',
            videos: domNewItems,
            collected: collectedMap.size,
          });
        }
        return domNewItems.length;
      } catch {
        return 0;
      }
    };

    await extractDomAnchors();
    onEvent({
      type: 'status',
      phase: 'scrolling',
      message: `Đã tải trang đầu (${collectedMap.size} bài). Đang tự động cuộn để lấy thêm...`,
      collected: collectedMap.size,
      batches: batchCount,
    });

    let staleRounds = 0;
    let lastCount = collectedMap.size;

    for (let round = 0; round < maxRounds; round++) {
      if (signal?.aborted) break;
      if (sawHasMoreFalse) break;
      if (emptyApiResponses >= 3 && round >= 4) break;

      // Simulate natural mouseWheel scrolling via Input.dispatchMouseEvent (no JS injection!)
      for (let step = 0; step < 5; step++) {
        if (signal?.aborted) break;
        await call('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 640 + Math.floor(Math.random() * 60),
          y: 460 + Math.floor(Math.random() * 80),
          deltaX: 0,
          deltaY: 1100 + Math.floor(Math.random() * 350),
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 220 + Math.floor(Math.random() * 90)));
      }

      await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 400)));

      if (collectedMap.size > lastCount) {
        lastCount = collectedMap.size;
        staleRounds = 0;
      } else {
        staleRounds++;
        if (staleRounds === 3) {
          await extractDomAnchors();
          if (collectedMap.size > lastCount) {
            lastCount = collectedMap.size;
            staleRounds = 0;
          }
        }
      }

      // Fail fast if TikTok blocked initial render & API on guest IP, else stop after ~7 stale rounds
      if (collectedMap.size === 0 && staleRounds >= 2) {
        break;
      }
      if (staleRounds >= 7 || Date.now() - lastItemAddedAt > 20000) {
        break;
      }
    }

    await extractDomAnchors();

    let stopReason: DeepScanEvent['stopReason'] = 'stalled';
    let finalMsg = `Đã quét xong tự động qua Chrome CDP: thu thập ${collectedMap.size} bài đăng.`;

    if (signal?.aborted) {
      stopReason = 'aborted';
      finalMsg = `Đã dừng quét. Hiện đã lưu ${collectedMap.size} bài đăng vào danh sách.`;
    } else if (sawHasMoreFalse) {
      stopReason = 'completed';
      finalMsg = `Hoàn tất toàn bộ kênh qua Chrome CDP: ${collectedMap.size} bài đăng.`;
    } else if (collectedMap.size === 0 && parsedCookies.length === 0) {
      stopReason = 'guest_limit';
      finalMsg =
        'TikTok đang giới hạn tải trang từ IP máy chủ ở chế độ khách không Cookie. Hãy mở "Tuỳ chọn nâng cao" bên dưới để dán Cookie TikTok (hoặc Proxy sạch) rồi quét lại, hoặc dùng tab "Script trình duyệt".';
    } else if (emptyApiResponses >= 3 && parsedCookies.length === 0) {
      stopReason = 'guest_limit';
      finalMsg = `Đã thu thập ${collectedMap.size} bài đăng. TikTok đã ngắt API khách từ IP máy chủ — hãy dán Cookie phiên TikTok (hoặc Proxy) ở tuỳ chọn nâng cao để cuộn tiếp tới 100%.`;
    } else if (emptyApiResponses >= 3 || collectedMap.size === 0) {
      stopReason = 'guest_limit';
      finalMsg = `Đã thu thập ${collectedMap.size} bài đăng trước khi TikTok giới hạn tốc độ tải API trên phiên này.`;
    }

    onEvent({
      type: 'complete',
      stopReason,
      collected: collectedMap.size,
      batches: batchCount,
      message: finalMsg,
    });
  } finally {
    if (signal) {
      signal.removeEventListener('abort', cleanup);
    }
    cleanup();
  }
}
