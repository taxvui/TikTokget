import type { TikTokVideoItem } from '../types';

export function formatCompactNumber(num: number | null | undefined): string {
  if (num === null || num === undefined || Number.isNaN(num)) return '—';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return num.toLocaleString('vi-VN');
}

export function formatDateVi(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatDuration(sec: number | null): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function downloadTextFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeCsvCell(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsvContent(videos: TikTokVideoItem[]): string {
  const headers = [
    'STT',
    'ID',
    'Loại',
    'Link TikTok',
    'Tiêu đề / Mô tả',
    'Lượt xem',
    'Lượt thích',
    'Bình luận',
    'Chia sẻ',
    'Lưu',
    'Thời lượng (giây)',
    'Ngày đăng',
    'Đã ghim',
    'Âm thanh',
  ];

  const rows = videos.map((v, idx) =>
    [
      idx + 1,
      v.id,
      v.mediaType === 'image' ? 'Bộ ảnh' : 'Video',
      v.url,
      v.title,
      v.views ?? '',
      v.likes ?? '',
      v.comments ?? '',
      v.shares ?? '',
      v.bookmarks ?? '',
      v.durationSec ?? '',
      v.createdAt ? formatDateVi(v.createdAt) : '',
      v.pinned ? 'Có' : 'Không',
      v.audioTitle ?? '',
    ]
      .map(escapeCsvCell)
      .join(',')
  );

  // UTF-8 BOM for proper Vietnamese rendering in Microsoft Excel
  return `\uFEFF${headers.join(',')}\n${rows.join('\n')}`;
}

export function buildConsoleExtractorScript(username: string): string {
  const cleanUser = username.replace(/^@/, '') || 'khanhlg204';
  return `(async () => {
  const user = ${JSON.stringify(cleanUser)};
  const map = new Map();
  const origFetch = window.fetch;
  const parseItems = (list) => {
    if (!Array.isArray(list)) return;
    for (const v of list) {
      if (!v?.id) continue;
      const u = v.author?.uniqueId || user;
      const isPhoto = Boolean(v.imagePost?.images?.length);
      map.set(String(v.id), {
        id: String(v.id),
        url: 'https://www.tiktok.com/@' + u + (isPhoto ? '/photo/' : '/video/') + v.id,
        mediaType: isPhoto ? 'image' : 'video',
        imageCount: isPhoto ? v.imagePost.images.length : null,
        title: v.desc || ((isPhoto ? 'Bộ ảnh #' : 'Video #') + v.id),
        description: v.desc || '',
        views: v.stats?.playCount ?? null,
        likes: v.stats?.diggCount ?? null,
        comments: v.stats?.commentCount ?? null,
        shares: v.stats?.shareCount ?? null,
        bookmarks: v.stats?.collectCount ?? null,
        durationSec: v.video?.duration ?? null,
        createdAt: v.createTime ? new Date(v.createTime * 1000).toISOString() : null,
        pinned: Boolean(v.isPinnedItem),
        audioTitle: v.music?.title || undefined
      });
    }
  };
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    try {
      const reqUrl = String(args[0]?.url || args[0] || '');
      if (reqUrl.includes('/api/post/item_list')) {
        const clone = res.clone();
        const json = await clone.json();
        parseItems(json?.itemList);
      }
    } catch {}
    return res;
  };
  const scanDom = () => {
    document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]').forEach((a) => {
      const m = a.href.match(/tiktok\\.com\\/@([^/]+)\\/(video|photo)\\/(\\d+)/i);
      if (m && !map.has(m[3])) {
        const img = a.querySelector('img');
        const isPhoto = m[2].toLowerCase() === 'photo';
        map.set(m[3], {
          id: m[3],
          url: 'https://www.tiktok.com/@' + m[1] + '/' + m[2].toLowerCase() + '/' + m[3],
          mediaType: isPhoto ? 'image' : 'video',
          title: img?.alt || ((isPhoto ? 'Bộ ảnh #' : 'Video #') + m[3]),
          description: img?.alt || '',
          pinned: /Đã ghim|Pinned/i.test(a.innerText || '')
        });
      }
    });
  };
  scanDom();
  let stale = 0, lastSize = 0;
  window.__stopTikScan = false;
  console.log('[TikLink] Bắt đầu cuộn trang thu thập toàn bộ bài đăng @' + user + '...');
  while (stale < 7 && !window.__stopTikScan) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 1500));
    scanDom();
    if (map.size === lastSize) stale++;
    else { stale = 0; lastSize = map.size; }
    console.log('[TikLink] Đã thu thập: ' + map.size + ' bài đăng');
  }
  window.fetch = origFetch;
  const out = JSON.stringify(Array.from(map.values()), null, 2);
  const blob = new Blob([out], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = user + '_all_videos.json';
  link.click();
  try { await navigator.clipboard.writeText(out); console.log('[TikLink] Đã sao chép JSON vào Clipboard!'); } catch {}
  console.log('[TikLink] Hoàn tất! Tổng cộng ' + map.size + ' bài đăng đã được lưu.');
})();`;
}
