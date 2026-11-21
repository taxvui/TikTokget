import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Archive,
  Check,
  CheckSquare,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Film,
  Image as ImageIcon,
  LayoutGrid,
  Pin,
  Play,
  RefreshCw,
  Search,
  Square,
  Table2,
  User,
} from 'lucide-react';
import type {
  ResolveVideoResponse,
  ScanResponse,
  TikTokProfile,
  TikTokVideoItem,
} from './types';
import {
  buildCsvContent,
  downloadTextFile,
  formatCompactNumber,
  formatDateVi,
  formatDuration,
} from './utils/exportUtils';
import { VideoThumbnail } from './components/VideoThumbnail';
import { VideoPreviewModal } from './components/VideoPreviewModal';
import { FullScanPanel } from './components/FullScanPanel';

const DEFAULT_TARGET = 'https://www.tiktok.com/@khanhlg204';

type ScanMode = 'channel' | 'video';
type FilterMode = 'all' | 'pinned' | 'high_views';
type SortMode = 'order' | 'views_desc' | 'date_desc' | 'likes_desc';
type ViewMode = 'table' | 'grid';

function isVideoUrlInput(input: string): boolean {
  return /\/(?:video|photo)\/\d+|vt\.tiktok\.com|vm\.tiktok\.com|tiktok\.com\/t\//i.test(input);
}

function isPhotoItem(video: TikTokVideoItem): boolean {
  return video.mediaType === 'image' || /\/photo\/\d+/i.test(video.url);
}

function formatFileSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export default function App() {
  const [scanMode, setScanMode] = useState<ScanMode>('channel');
  const [targetInput, setTargetInput] = useState(DEFAULT_TARGET);
  const [isScanning, setIsScanning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [profile, setProfile] = useState<TikTokProfile | null>(null);
  const [videos, setVideos] = useState<TikTokVideoItem[]>([]);
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  const [resolvedMp4, setResolvedMp4] = useState<ResolveVideoResponse | null>(null);
  const [copiedMp4Url, setCopiedMp4Url] = useState(false);
  const [copiedPhotoIdx, setCopiedPhotoIdx] = useState<number | 'all' | null>(null);
  const [isBatchResolvingMp4, setIsBatchResolvingMp4] = useState(false);
  const [isBatchZipping, setIsBatchZipping] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortMode, setSortMode] = useState<SortMode>('order');
  const [viewMode, setViewMode] = useState<ViewMode>('table');

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedBulk, setCopiedBulk] = useState<'all' | 'selected' | null>(null);
  const [previewVideo, setPreviewVideo] = useState<TikTokVideoItem | null>(null);
  const [isEnriching, setIsEnriching] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const runScan = async (target: string) => {
    const clean = target.trim();
    if (!clean) {
      setErrorMsg('Vui lòng nhập đường dẫn kênh TikTok hoặc @username.');
      return;
    }

    setIsScanning(true);
    setErrorMsg(null);
    setAvatarFailed(false);
    setSelectedIds(new Set());

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: clean }),
      });
      const data = (await res.json()) as ScanResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Không thể quét kênh TikTok này.');
      }

      setProfile(data.profile);
      setVideos(data.videos);
      setScannedAt(data.meta.scannedAt);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Đã xảy ra lỗi kết nối khi quét kênh.'
      );
    } finally {
      setIsScanning(false);
    }
  };

  const runResolveSingleVideo = async (videoUrl: string) => {
    const clean = videoUrl.trim();
    if (!clean) {
      setErrorMsg('Vui lòng nhập đường dẫn video TikTok cần bắt .MP4.');
      return;
    }

    setIsScanning(true);
    setErrorMsg(null);
    setResolvedMp4(null);

    try {
      const res = await fetch('/api/resolve-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: clean }),
      });
      const data = (await res.json()) as ResolveVideoResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Không thể trích xuất .MP4 hoặc bộ ảnh từ đường dẫn này.');
      }

      setResolvedMp4(data);
      handleImportVideos([data.video]);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Đã xảy ra lỗi khi trích xuất media.'
      );
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    void runScan(DEFAULT_TARGET);
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const clean = targetInput.trim();
    if (scanMode === 'video' || isVideoUrlInput(clean)) {
      setScanMode('video');
      void runResolveSingleVideo(clean);
    } else {
      void runScan(clean);
    }
  };

  const getVideoDownloadHref = (video: TikTokVideoItem) => {
    const uname =
      video.url.match(/tiktok\.com\/@([^/]+)\/(?:video|photo)\//i)?.[1] ||
      profile?.username ||
      'tiktok';
    if (isPhotoItem(video)) {
      return `/api/media/photo-zip/${encodeURIComponent(video.id)}?u=${encodeURIComponent(uname)}`;
    }
    return `/api/media/video/${encodeURIComponent(video.id)}?u=${encodeURIComponent(
      uname
    )}&download=1`;
  };

  const handleBatchDownloadMp4 = async () => {
    const selectedList = filteredVideos.filter((v) => selectedIds.has(v.id));
    if (selectedList.length === 0) return;

    for (const item of selectedList) {
      const a = document.createElement('a');
      a.href = getVideoDownloadHref(item);
      a.download = isPhotoItem(item)
        ? `tiktok_${item.id}_images.zip`
        : `tiktok_${item.id}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      await new Promise((r) => setTimeout(r, 700));
    }
  };

  const handleBatchDownloadPhotosZip = async () => {
    const selectedList = filteredVideos.filter((v) => selectedIds.has(v.id));
    if (selectedList.length === 0) return;

    setIsBatchZipping(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/media/photos-zip-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: selectedList.map((s) => s.url) }),
      });
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          errData.error || 'Không có bài đăng dạng bộ ảnh nào trong các mục đã chọn.'
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${profile?.username || 'tiktok'}_bo_anh_${selectedList.length}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Lỗi tải gói .ZIP bộ ảnh đã chọn.'
      );
    } finally {
      setIsBatchZipping(false);
    }
  };

  const handleExportSelectedMp4Links = async () => {
    const selectedList = filteredVideos.filter((v) => selectedIds.has(v.id));
    if (selectedList.length === 0) return;

    setIsBatchResolvingMp4(true);
    try {
      const allResolved: Array<{
        id: string;
        mediaType: 'video' | 'image';
        mp4CdnUrl: string | null;
        imageUrls?: string[];
      }> = [];
      for (let i = 0; i < selectedList.length; i += 10) {
        const chunk = selectedList.slice(i, i + 10);
        const res = await fetch('/api/resolve-mp4-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: chunk.map((c) => c.url) }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            results: Array<{
              id: string;
              mediaType: 'video' | 'image';
              mp4CdnUrl: string | null;
              imageUrls?: string[];
            }>;
          };
          allResolved.push(...data.results);
        }
      }

      const lines: string[] = [];
      for (const r of allResolved) {
        if (r.mediaType === 'image' && r.imageUrls?.length) {
          lines.push(...r.imageUrls);
        } else if (r.mp4CdnUrl) {
          lines.push(r.mp4CdnUrl);
        }
      }

      if (lines.length > 0) {
        downloadTextFile(
          lines.join('\n'),
          `${profile?.username || 'tiktok'}_media_direct_links_${lines.length}.txt`,
          'text/plain;charset=utf-8'
        );
      }
    } finally {
      setIsBatchResolvingMp4(false);
    }
  };

  const handleImportVideos = (incoming: TikTokVideoItem[]): number => {
    let addedCount = 0;
    setVideos((prev) => {
      const existingMap = new Map<string, TikTokVideoItem>(
        prev.map((item) => [item.id, item])
      );
      let nextOrder = prev.length + 1;

      for (const item of incoming) {
        const existing = existingMap.get(item.id);
        if (!existing) {
          addedCount++;
          existingMap.set(item.id, {
            ...item,
            orderIndex: nextOrder++,
          });
        } else {
          // Merge richer fields if imported JSON has metrics missing in SSR
          existingMap.set(item.id, {
            ...existing,
            title:
              existing.title.startsWith('Video #') && !item.title.startsWith('Video #')
                ? item.title
                : existing.title,
            description: existing.description || item.description,
            views: existing.views ?? item.views,
            viewsFormatted:
              existing.views !== null
                ? existing.viewsFormatted
                : formatCompactNumber(item.views),
            likes: existing.likes ?? item.likes,
            comments: existing.comments ?? item.comments,
            shares: existing.shares ?? item.shares,
            bookmarks: existing.bookmarks ?? item.bookmarks,
            durationSec: existing.durationSec ?? item.durationSec,
            createdAt: existing.createdAt || item.createdAt,
            audioTitle: existing.audioTitle || item.audioTitle,
          });
        }
      }

      return Array.from(existingMap.values());
    });
    return addedCount;
  };

  const handleEnrichImported = async () => {
    const candidates = videos.filter((v) => v.title.startsWith('Video #')).slice(0, 20);
    if (candidates.length === 0) return;

    setIsEnriching(true);
    try {
      const res = await fetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: candidates.map((c) => c.url) }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        enriched: Array<{ id: string; title?: string }>;
      };
      const map = new Map(data.enriched.map((e) => [e.id, e.title]));
      setVideos((prev) =>
        prev.map((v) => {
          const newTitle = map.get(v.id);
          return newTitle ? { ...v, title: newTitle, description: newTitle } : v;
        })
      );
    } finally {
      setIsEnriching(false);
    }
  };

  const filteredVideos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = videos.filter((v) => {
      if (filterMode === 'pinned' && !v.pinned) return false;
      if (filterMode === 'high_views' && (v.views ?? 0) < 10_000) return false;
      if (q) {
        return (
          v.title.toLowerCase().includes(q) ||
          v.description.toLowerCase().includes(q) ||
          v.id.includes(q) ||
          v.url.toLowerCase().includes(q)
        );
      }
      return true;
    });

    if (sortMode === 'views_desc') {
      list = [...list].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
    } else if (sortMode === 'date_desc') {
      list = [...list].sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
    } else if (sortMode === 'likes_desc') {
      list = [...list].sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1));
    } else {
      list = [...list].sort((a, b) => a.orderIndex - b.orderIndex);
    }

    return list;
  }, [videos, searchQuery, filterMode, sortMode]);

  const activeExportList = useMemo(() => {
    if (selectedIds.size > 0) {
      return filteredVideos.filter((v) => selectedIds.has(v.id));
    }
    return filteredVideos;
  }, [filteredVideos, selectedIds]);

  const handleCopySingle = async (video: TikTokVideoItem) => {
    try {
      await navigator.clipboard.writeText(video.url);
      setCopiedId(video.id);
      setTimeout(() => setCopiedId((cur) => (cur === video.id ? null : cur)), 1600);
    } catch {
      // Clipboard blocked
    }
  };

  const handleCopyUrls = async (mode: 'all' | 'selected') => {
    const list =
      mode === 'selected'
        ? filteredVideos.filter((v) => selectedIds.has(v.id))
        : filteredVideos;
    if (list.length === 0) return;

    try {
      await navigator.clipboard.writeText(list.map((v) => v.url).join('\n'));
      setCopiedBulk(mode);
      setTimeout(() => setCopiedBulk(null), 1800);
    } catch {
      // Clipboard blocked
    }
  };

  const handleDownloadTxt = () => {
    const list = activeExportList;
    if (list.length === 0) return;
    const uname = profile?.username || 'tiktok';
    downloadTextFile(
      list.map((v) => v.url).join('\n'),
      `${uname}_video_links_${list.length}.txt`,
      'text/plain;charset=utf-8'
    );
  };

  const handleDownloadCsv = () => {
    const list = activeExportList;
    if (list.length === 0) return;
    const uname = profile?.username || 'tiktok';
    downloadTextFile(
      buildCsvContent(list),
      `${uname}_videos_${list.length}.csv`,
      'text/csv;charset=utf-8'
    );
  };

  const handleDownloadJson = () => {
    const list = activeExportList;
    if (list.length === 0) return;
    const uname = profile?.username || 'tiktok';
    downloadTextFile(
      JSON.stringify({ profile, totalExported: list.length, videos: list }, null, 2),
      `${uname}_videos_${list.length}.json`,
      'application/json;charset=utf-8'
    );
  };

  const allFilteredSelected =
    filteredVideos.length > 0 && filteredVideos.every((v) => selectedIds.has(v.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredVideos.map((v) => v.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalChannelVideos = profile?.videoCount || videos.length;
  const coveragePct =
    totalChannelVideos > 0
      ? Math.min(100, Math.round((videos.length / totalChannelVideos) * 1000) / 10)
      : 0;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1360px] items-center justify-between gap-8 px-4 py-3.5 sm:px-6 lg:px-8">
          <a
            href="#scanner"
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            TikLink
          </a>

          <nav
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
            aria-label="Điều hướng chính"
          >
            <a
              href="#scanner"
              className="transition-colors hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              Quét kênh
            </a>
            <a
              href="#video-list"
              className="transition-colors hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              Danh sách link
            </a>
            <a
              href="#full-scan"
              className="transition-colors hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              Quét toàn bộ
            </a>
            <a
              href="#export-bar"
              className="transition-colors hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              Xuất tệp
            </a>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              disabled={filteredVideos.length === 0}
              onClick={() => handleCopyUrls('all')}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-rose-600"
            >
              {copiedBulk === 'all' ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span>
                {copiedBulk === 'all'
                  ? `Đã chép ${filteredVideos.length} link`
                  : `Sao chép ${filteredVideos.length} link`}
              </span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1360px] space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        {/* Hero / Scan Input Section */}
        <section
          id="scanner"
          className="rounded-xl border border-slate-200 bg-white p-6"
          aria-labelledby="scanner-heading"
        >
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <h1
                id="scanner-heading"
                className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl [text-wrap:balance]"
              >
                Quét kênh, Bắt .MP4 & Tách bộ ảnh TikTok
              </h1>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                Dán link kênh để lấy danh sách bài đăng, link video để bắt .MP4, hoặc link bộ ảnh để tách từng link ảnh gốc và nén tải về .ZIP độ phân giải cao nhất.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setScanMode('channel');
                    if (isVideoUrlInput(targetInput) || !targetInput.trim()) {
                      setTargetInput(DEFAULT_TARGET);
                    }
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    scanMode === 'channel'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Quét cả kênh
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScanMode('video');
                    if (!isVideoUrlInput(targetInput) && videos[0]?.url) {
                      setTargetInput(videos[0].url);
                    }
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    scanMode === 'video'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Bắt .MP4 / Bộ ảnh
                </button>
              </div>

              {scannedAt && (
                <div className="text-xs text-slate-500 tabular-nums whitespace-nowrap shrink-0">
                  Cập nhật lúc{' '}
                  {new Date(scannedAt).toLocaleTimeString('vi-VN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </div>
              )}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                placeholder={
                  scanMode === 'video'
                    ? 'https://www.tiktok.com/@user/photo/... hoặc /video/... hoặc vt.tiktok.com/...'
                    : 'https://www.tiktok.com/@khanhlg204 hoặc @username'
                }
                aria-label="Đường dẫn kênh, video hoặc bộ ảnh TikTok"
                className="h-11 w-full rounded-lg border border-slate-200 bg-slate-50 pl-10 pr-4 font-mono text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-rose-500 focus:bg-white focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={isScanning}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-rose-600 px-6 text-sm font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-60 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
            >
              {scanMode === 'video' ? (
                <Film className={`h-4 w-4 ${isScanning ? 'animate-pulse' : ''}`} />
              ) : (
                <RefreshCw className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
              )}
              <span>
                {isScanning
                  ? scanMode === 'video'
                    ? 'Đang trích xuất...'
                    : 'Đang quét kênh...'
                  : scanMode === 'video'
                    ? 'Bắt .MP4 / Tách ảnh'
                    : 'Quét kênh'}
              </span>
            </button>
          </form>

          {resolvedMp4 && resolvedMp4.mediaType === 'image' && resolvedMp4.images.length > 0 && (
            <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/80 p-4 space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium text-rose-600">
                    <ImageIcon className="h-3.5 w-3.5" />
                    <span>Bộ ảnh TikTok ({resolvedMp4.images.length} ảnh độ phân giải cao)</span>
                  </div>
                  <div className="mt-1 truncate text-sm font-semibold text-slate-900">
                    {resolvedMp4.video.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600 tabular-nums">
                    <span>@{resolvedMp4.username}</span>
                    {resolvedMp4.images[0]?.width && resolvedMp4.images[0]?.height && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">
                          {resolvedMp4.images[0].width}×{resolvedMp4.images[0].height}
                        </span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>Tổng dung lượng: {formatFileSize(resolvedMp4.fileSizeBytes)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatCompactNumber(resolvedMp4.video.views)} lượt xem</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {resolvedMp4.zipDownloadUrl && (
                    <a
                      href={resolvedMp4.zipDownloadUrl}
                      download={`tiktok_${resolvedMp4.username}_${resolvedMp4.video.id}_images.zip`}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      <Archive className="h-3.5 w-3.5" />
                      <span>Tải tất cả (.ZIP)</span>
                    </a>
                  )}

                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(
                        resolvedMp4.images.map((img) => img.cdnUrl).join('\n')
                      );
                      setCopiedPhotoIdx('all');
                      setTimeout(() => setCopiedPhotoIdx(null), 1800);
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                  >
                    {copiedPhotoIdx === 'all' ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5 text-slate-500" />
                    )}
                    <span>
                      {copiedPhotoIdx === 'all'
                        ? `Đã chép ${resolvedMp4.images.length} link ảnh`
                        : `Sao chép ${resolvedMp4.images.length} link ảnh`}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      downloadTextFile(
                        resolvedMp4.images.map((img) => img.cdnUrl).join('\n'),
                        `${resolvedMp4.username}_${resolvedMp4.video.id}_image_links.txt`,
                        'text/plain;charset=utf-8'
                      )
                    }
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                  >
                    <FileText className="h-3.5 w-3.5 text-slate-500" />
                    <span>Tải link (.TXT)</span>
                  </button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {resolvedMp4.images.map((img) => (
                  <div
                    key={img.index}
                    className="flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white"
                  >
                    <button
                      type="button"
                      onClick={() => setPreviewVideo(resolvedMp4.video)}
                      className="relative aspect-[3/4] w-full overflow-hidden bg-slate-900"
                    >
                      <img
                        src={img.proxyUrl}
                        alt={`Ảnh ${img.index}`}
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-200 hover:scale-[1.02]"
                      />
                      <span className="absolute left-2 top-2 rounded bg-slate-950/75 px-2 py-0.5 font-mono text-[11px] font-semibold text-white tabular-nums">
                        #{img.index}
                      </span>
                      <span className="absolute bottom-2 right-2 rounded bg-slate-950/75 px-2 py-0.5 font-mono text-[10px] text-white tabular-nums">
                        {img.width && img.height ? `${img.width}×${img.height}` : img.format.toUpperCase()}
                        {img.sizeBytes ? ` · ${formatFileSize(img.sizeBytes)}` : ''}
                      </span>
                    </button>

                    <div className="p-2.5 space-y-2">
                      <div
                        className="truncate font-mono text-[11px] text-slate-600"
                        title={img.cdnUrl}
                      >
                        {img.cdnUrl}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={async () => {
                            await navigator.clipboard.writeText(img.cdnUrl);
                            setCopiedPhotoIdx(img.index);
                            setTimeout(() => setCopiedPhotoIdx(null), 1600);
                          }}
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                        >
                          {copiedPhotoIdx === img.index ? (
                            <Check className="h-3 w-3 text-emerald-600" />
                          ) : (
                            <Copy className="h-3 w-3 text-slate-400" />
                          )}
                          <span>{copiedPhotoIdx === img.index ? 'Đã chép' : 'Chép link'}</span>
                        </button>
                        <a
                          href={img.downloadUrl}
                          download={`tiktok_${resolvedMp4.video.id}_anh_${img.index}.${img.format}`}
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                        >
                          <Download className="h-3 w-3 text-rose-600" />
                          <span>Tải ảnh</span>
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {resolvedMp4 && resolvedMp4.mediaType === 'video' && resolvedMp4.mp4DownloadUrl && (
            <div className="mt-5 flex flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50/80 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3.5 min-w-0">
                <button
                  type="button"
                  onClick={() => setPreviewVideo(resolvedMp4.video)}
                  className="group relative h-16 w-12 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-900"
                  aria-label="Xem trước video vừa bắt"
                >
                  <VideoThumbnail
                    src={resolvedMp4.video.thumbnailUrl}
                    alt={resolvedMp4.video.title}
                    className="h-full w-full"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-slate-950/35 opacity-0 transition-opacity group-hover:opacity-100">
                    <Play className="h-4 w-4 fill-white text-white" />
                  </span>
                </button>

                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate">
                    {resolvedMp4.video.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600 tabular-nums">
                    <span className="font-mono">MP4</span>
                    <span aria-hidden="true">·</span>
                    <span>Dung lượng: {formatFileSize(resolvedMp4.fileSizeBytes)}</span>
                    <span aria-hidden="true">·</span>
                    <span>Thời lượng: {formatDuration(resolvedMp4.video.durationSec)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatCompactNumber(resolvedMp4.video.views)} lượt xem</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <a
                  href={resolvedMp4.mp4DownloadUrl}
                  download={`tiktok_${resolvedMp4.video.id}.mp4`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Tải về .MP4</span>
                </a>

                <button
                  type="button"
                  onClick={() => setPreviewVideo(resolvedMp4.video)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>Phát thử</span>
                </button>

                {resolvedMp4.mp4CdnUrl && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!resolvedMp4.mp4CdnUrl) return;
                      await navigator.clipboard.writeText(resolvedMp4.mp4CdnUrl);
                      setCopiedMp4Url(true);
                      setTimeout(() => setCopiedMp4Url(false), 1800);
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                  >
                    {copiedMp4Url ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5 text-slate-500" />
                    )}
                    <span>{copiedMp4Url ? 'Đã chép link .MP4' : 'Chép link .MP4 trực tiếp'}</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {errorMsg && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
            >
              <div className="flex items-center gap-2.5">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
                <span>{errorMsg}</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  scanMode === 'video' || isVideoUrlInput(targetInput)
                    ? runResolveSingleVideo(targetInput)
                    : runScan(targetInput)
                }
                className="font-medium text-rose-700 underline underline-offset-2 hover:text-rose-900 whitespace-nowrap shrink-0"
              >
                Thử lại
              </button>
            </div>
          )}
        </section>

        {/* Creator Profile Overview */}
        {profile && (
          <section
            className="rounded-xl border border-slate-200 bg-white p-6"
            aria-label="Thông tin kênh TikTok"
          >
            <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-4">
                {profile.avatarUrl && !avatarFailed ? (
                  <img
                    src={profile.avatarUrl}
                    alt={profile.nickname}
                    referrerPolicy="no-referrer"
                    onError={() => setAvatarFailed(true)}
                    className="h-16 w-16 shrink-0 rounded-full border border-slate-200 object-cover bg-slate-100"
                  />
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-slate-500">
                    <User className="h-7 w-7" />
                  </div>
                )}

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h2 className="text-lg font-bold text-slate-900 truncate">
                      {profile.nickname}
                    </h2>
                    <a
                      href={profile.profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-sm text-slate-500 hover:text-rose-600 whitespace-nowrap shrink-0"
                    >
                      <span>@{profile.username}</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>

                  {profile.bio && (
                    <p className="mt-1 max-w-2xl text-sm text-slate-600">{profile.bio}</p>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 tabular-nums">
                    <span>
                      <strong className="font-semibold text-slate-800">
                        {formatCompactNumber(profile.followerCount)}
                      </strong>{' '}
                      Follower
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      <strong className="font-semibold text-slate-800">
                        {formatCompactNumber(profile.heartCount)}
                      </strong>{' '}
                      Lượt thích
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      <strong className="font-semibold text-slate-800">
                        {profile.videoCount.toLocaleString('vi-VN')}
                      </strong>{' '}
                      Tổng video trên kênh
                    </span>
                    {profile.region && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>Khu vực {profile.region}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Coverage Metric Block */}
              <div className="w-full shrink-0 border-t border-slate-100 pt-4 lg:w-80 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium text-slate-600">Tiến độ trích xuất kênh</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {videos.length.toLocaleString('vi-VN')} /{' '}
                    {totalChannelVideos.toLocaleString('vi-VN')} ({coveragePct}%)
                  </span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      coveragePct >= 99 ? 'bg-emerald-600' : 'bg-rose-600'
                    }`}
                    style={{ width: `${coveragePct}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-slate-500">
                    {videos.length < totalChannelVideos
                      ? `Còn thiếu ${(totalChannelVideos - videos.length).toLocaleString('vi-VN')} video`
                      : 'Đã đủ 100% video'}
                  </span>
                  {videos.length < totalChannelVideos && (
                    <a
                      href="#full-scan"
                      className="font-medium text-rose-600 hover:text-rose-700 whitespace-nowrap shrink-0"
                    >
                      Lấy toàn bộ →
                    </a>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Video Links Workbench */}
        <section
          id="video-list"
          className="rounded-xl border border-slate-200 bg-white"
          aria-label="Danh sách link video"
        >
          {/* Toolbar */}
          <div className="flex flex-col gap-4 border-b border-slate-200 p-5">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-1 flex-wrap items-center gap-3">
                <div className="relative min-w-[240px] flex-1 sm:max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Lọc theo mô tả, #hashtag hoặc ID..."
                    aria-label="Tìm kiếm trong danh sách video"
                    className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-rose-500 focus:bg-white focus:outline-none"
                  />
                </div>

                {/* Segmented Filter Tabs */}
                <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => setFilterMode('all')}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      filterMode === 'all'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Tất cả ({videos.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilterMode('pinned')}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      filterMode === 'pinned'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Đã ghim
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilterMode('high_views')}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      filterMode === 'high_views'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Trên 10K xem
                  </button>
                </div>

                <select
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  aria-label="Sắp xếp danh sách"
                  className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 focus:border-rose-500 focus:outline-none"
                >
                  <option value="order">Thứ tự trên kênh</option>
                  <option value="views_desc">Lượt xem cao nhất</option>
                  <option value="date_desc">Mới đăng gần đây</option>
                  <option value="likes_desc">Lượt thích cao nhất</option>
                </select>
              </div>

              {/* Export & View Switcher */}
              <div id="export-bar" className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 mr-1">
                  <button
                    type="button"
                    onClick={() => setViewMode('table')}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      viewMode === 'table'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                    aria-label="Chế độ bảng"
                  >
                    <Table2 className="h-3.5 w-3.5" />
                    <span>Bảng</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('grid')}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      viewMode === 'grid'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                    aria-label="Chế độ lưới"
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                    <span>Lưới</span>
                  </button>
                </div>

                <button
                  type="button"
                  disabled={activeExportList.length === 0}
                  onClick={handleDownloadTxt}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <FileText className="h-3.5 w-3.5 text-slate-500" />
                  <span>Tải .TXT</span>
                </button>

                <button
                  type="button"
                  disabled={activeExportList.length === 0}
                  onClick={handleDownloadCsv}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />
                  <span>Tải .CSV</span>
                </button>

                <button
                  type="button"
                  disabled={activeExportList.length === 0}
                  onClick={handleDownloadJson}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <Download className="h-3.5 w-3.5 text-slate-500" />
                  <span>Tải .JSON</span>
                </button>
              </div>
            </div>

            {selectedIds.size > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-900 px-4 py-2.5 text-xs text-white">
                <span className="font-medium tabular-nums">
                  Đã chọn {selectedIds.size} video
                </span>
                <div className="flex flex-wrap items-center gap-4">
                  <button
                    type="button"
                    onClick={() => handleCopyUrls('selected')}
                    className="inline-flex items-center gap-1.5 font-medium text-emerald-400 hover:text-emerald-300 whitespace-nowrap shrink-0"
                  >
                    {copiedBulk === 'selected' ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {copiedBulk === 'selected'
                        ? 'Đã sao chép các link đã chọn'
                        : 'Sao chép link đã chọn'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={handleBatchDownloadMp4}
                    className="inline-flex items-center gap-1.5 font-medium text-white hover:text-rose-300 whitespace-nowrap shrink-0"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Tải mục đã chọn</span>
                  </button>
                  <button
                    type="button"
                    disabled={isBatchZipping}
                    onClick={handleBatchDownloadPhotosZip}
                    className="inline-flex items-center gap-1.5 font-medium text-amber-300 hover:text-amber-200 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    <span>{isBatchZipping ? 'Đang nén .ZIP...' : 'Tải bộ ảnh (.ZIP)'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isBatchResolvingMp4}
                    onClick={handleExportSelectedMp4Links}
                    className="inline-flex items-center gap-1.5 font-medium text-slate-200 hover:text-white disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Film className="h-3.5 w-3.5" />
                    <span>
                      {isBatchResolvingMp4
                        ? 'Đang lấy link media...'
                        : 'Xuất link .MP4 / Ảnh (.TXT)'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    className="text-slate-300 hover:text-white whitespace-nowrap shrink-0"
                  >
                    Bỏ chọn
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Content Area: Loading / Empty / Table / Grid */}
          {isScanning && videos.length === 0 ? (
            <div className="divide-y divide-slate-100 p-4">
              {Array.from({ length: 8 }).map((_, idx) => (
                <div key={idx} className="flex items-center gap-4 py-3">
                  <div className="h-4 w-4 animate-pulse rounded bg-slate-200" />
                  <div className="h-12 w-9 animate-pulse rounded bg-slate-200" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-2/3 animate-pulse rounded bg-slate-200" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" />
                  </div>
                  <div className="h-4 w-16 animate-pulse rounded bg-slate-100" />
                </div>
              ))}
            </div>
          ) : filteredVideos.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
              <p className="text-base font-semibold text-slate-900">
                {videos.length === 0
                  ? 'Chưa có video nào được quét'
                  : 'Không tìm thấy video khớp bộ lọc'}
              </p>
              <p className="mt-1 max-w-md text-sm text-slate-500">
                {videos.length === 0
                  ? 'Nhập URL kênh TikTok ở thanh phía trên và nhấn Quét kênh để lấy danh sách link video.'
                  : 'Thử xoá từ khoá tìm kiếm hoặc chuyển về chế độ Tất cả.'}
              </p>
              {videos.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setFilterMode('all');
                  }}
                  className="mt-4 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Đặt lại bộ lọc
                </button>
              )}
            </div>
          ) : viewMode === 'table' ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="w-10 py-3 pl-5 pr-2">
                      <button
                        type="button"
                        onClick={toggleSelectAll}
                        aria-label={allFilteredSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                        className="flex items-center justify-center text-slate-500 hover:text-slate-900"
                      >
                        {allFilteredSelected ? (
                          <CheckSquare className="h-4 w-4 text-rose-600" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                    </th>
                    <th className="w-12 py-3 px-2 text-right font-mono tabular-nums">#</th>
                    <th className="py-3 px-3">Video & Tiêu đề</th>
                    <th className="py-3 px-3">Link Video</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Lượt xem</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Thời lượng</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Ngày đăng</th>
                    <th className="py-3 pl-3 pr-5 text-right whitespace-nowrap">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredVideos.map((video, idx) => {
                    const isChecked = selectedIds.has(video.id);
                    return (
                      <tr
                        key={video.id}
                        className={`transition-colors hover:bg-slate-50/80 ${
                          isChecked ? 'bg-rose-50/40' : ''
                        }`}
                      >
                        <td className="py-2.5 pl-5 pr-2">
                          <button
                            type="button"
                            onClick={() => toggleSelectOne(video.id)}
                            aria-label={`Chọn video ${video.id}`}
                            className="flex items-center justify-center text-slate-400 hover:text-slate-900"
                          >
                            {isChecked ? (
                              <CheckSquare className="h-4 w-4 text-rose-600" />
                            ) : (
                              <Square className="h-4 w-4" />
                            )}
                          </button>
                        </td>

                        <td className="py-2.5 px-2 text-right font-mono text-xs text-slate-400 tabular-nums">
                          {idx + 1}
                        </td>

                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => setPreviewVideo(video)}
                              className="group relative h-12 w-9 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-100 focus-visible:outline-2 focus-visible:outline-rose-600"
                              aria-label={`Xem trước ${video.title}`}
                            >
                              <VideoThumbnail
                                src={video.thumbnailUrl}
                                alt={video.title}
                                className="h-full w-full"
                              />
                              <span className="absolute inset-0 flex items-center justify-center bg-slate-950/30 opacity-0 transition-opacity group-hover:opacity-100">
                                <Play className="h-3.5 w-3.5 fill-white text-white" />
                              </span>
                            </button>

                            <div className="min-w-0 max-w-md">
                              <div className="truncate font-medium text-slate-900">
                                {video.title}
                              </div>
                              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                                <span className="font-mono tabular-nums">{video.id}</span>
                                {video.pinned && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="inline-flex items-center gap-1 font-medium text-rose-600">
                                      <Pin className="h-3 w-3" />
                                      <span>Đã ghim</span>
                                    </span>
                                  </>
                                )}
                                {video.likes !== null && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="tabular-nums">
                                      {formatCompactNumber(video.likes)} thích
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>

                        <td className="py-2.5 px-3">
                          <a
                            href={video.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block max-w-[300px] truncate font-mono text-xs text-slate-600 underline decoration-slate-200 underline-offset-2 hover:text-rose-600 hover:decoration-rose-300"
                            title={video.url}
                          >
                            {video.url}
                          </a>
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono text-xs font-medium text-slate-800 tabular-nums whitespace-nowrap">
                          {formatCompactNumber(video.views)}
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                          {formatDuration(video.durationSec)}
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                          {formatDateVi(video.createdAt)}
                        </td>

                        <td className="py-2.5 pl-3 pr-5 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleCopySingle(video)}
                              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 whitespace-nowrap shrink-0"
                            >
                              {copiedId === video.id ? (
                                <Check className="h-3.5 w-3.5 text-emerald-600" />
                              ) : (
                                <Copy className="h-3.5 w-3.5 text-slate-400" />
                              )}
                              <span>{copiedId === video.id ? 'Đã chép' : 'Chép link'}</span>
                            </button>

                            <a
                              href={getVideoDownloadHref(video)}
                              download={
                                isPhotoItem(video)
                                  ? `tiktok_${video.id}_images.zip`
                                  : `tiktok_${video.id}.mp4`
                              }
                              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 whitespace-nowrap shrink-0"
                            >
                              {isPhotoItem(video) ? (
                                <Archive className="h-3 w-3 text-rose-600" />
                              ) : (
                                <Download className="h-3 w-3 text-rose-600" />
                              )}
                              <span>{isPhotoItem(video) ? '.ZIP' : '.MP4'}</span>
                            </a>

                            <button
                              type="button"
                              onClick={() => setPreviewVideo(video)}
                              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 whitespace-nowrap shrink-0"
                            >
                              {isPhotoItem(video) ? (
                                <ImageIcon className="h-3 w-3 text-slate-500" />
                              ) : (
                                <Play className="h-3 w-3 text-slate-500" />
                              )}
                              <span>{isPhotoItem(video) ? 'Tách ảnh' : 'Xem'}</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredVideos.map((video) => {
                const isChecked = selectedIds.has(video.id);
                return (
                  <div
                    key={video.id}
                    className={`flex flex-col overflow-hidden rounded-xl border transition-colors ${
                      isChecked
                        ? 'border-rose-300 bg-rose-50/30'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="relative aspect-[9/12] w-full overflow-hidden bg-slate-900">
                      <VideoThumbnail
                        src={video.thumbnailUrl}
                        alt={video.title}
                        className="h-full w-full"
                      />
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/80 via-black/35 to-transparent" />

                      <button
                        type="button"
                        onClick={() => toggleSelectOne(video.id)}
                        aria-label={`Chọn video ${video.id}`}
                        className="absolute left-2.5 top-2.5 flex h-8 w-8 items-center justify-center rounded-lg bg-white/90 text-slate-700 shadow-sm hover:bg-white"
                      >
                        {isChecked ? (
                          <CheckSquare className="h-4 w-4 text-rose-600" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => setPreviewVideo(video)}
                        aria-label={`Xem trước ${video.title}`}
                        className="absolute right-2.5 top-2.5 flex h-8 w-8 items-center justify-center rounded-lg bg-slate-950/70 text-white hover:bg-slate-950"
                      >
                        <Play className="h-3.5 w-3.5 fill-white" />
                      </button>

                      <div className="absolute inset-x-3 bottom-2.5 flex items-center justify-between text-xs font-medium text-white tabular-nums">
                        <span>{formatCompactNumber(video.views)} xem</span>
                        <span>{video.pinned ? 'Đã ghim' : formatDateVi(video.createdAt)}</span>
                      </div>
                    </div>

                    <div className="flex flex-1 flex-col justify-between p-3.5">
                      <div>
                        <h3 className="line-clamp-2 text-sm font-medium text-slate-900">
                          {video.title}
                        </h3>
                        <div className="mt-1 truncate font-mono text-[11px] text-slate-500">
                          {video.url}
                        </div>
                      </div>

                      <div className="mt-3 flex items-center gap-1.5 pt-2 border-t border-slate-100">
                        <button
                          type="button"
                          onClick={() => handleCopySingle(video)}
                          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                        >
                          {copiedId === video.id ? (
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                          ) : (
                            <Copy className="h-3.5 w-3.5 text-slate-400" />
                          )}
                          <span>{copiedId === video.id ? 'Đã chép' : 'Chép'}</span>
                        </button>
                        <a
                          href={getVideoDownloadHref(video)}
                          download={
                            isPhotoItem(video)
                              ? `tiktok_${video.id}_images.zip`
                              : `tiktok_${video.id}.mp4`
                          }
                          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                        >
                          {isPhotoItem(video) ? (
                            <Archive className="h-3.5 w-3.5 text-rose-600" />
                          ) : (
                            <Download className="h-3.5 w-3.5 text-rose-600" />
                          )}
                          <span>{isPhotoItem(video) ? '.ZIP' : '.MP4'}</span>
                        </a>
                        <a
                          href={video.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                          aria-label="Mở trên TikTok"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Full-Channel 100% Extraction Panel */}
        <FullScanPanel
          username={profile?.username || 'khanhlg204'}
          scannedCount={videos.length}
          totalProfileCount={totalChannelVideos}
          onImportVideos={handleImportVideos}
          onEnrichImported={handleEnrichImported}
          isEnriching={isEnriching}
        />
      </main>

      <footer className="border-t border-slate-200 bg-white py-6">
        <div className="mx-auto flex max-w-[1360px] flex-col items-center justify-between gap-2 px-4 text-xs text-slate-500 sm:flex-row sm:px-6 lg:px-8">
          <span>TikLink Extractor — Trích xuất & xuất danh sách link video TikTok</span>
          <span>Hỗ trợ xuất định dạng TXT, CSV (Excel UTF-8) và JSON</span>
        </div>
      </footer>

      <VideoPreviewModal
        video={previewVideo}
        username={profile?.username}
        onClose={() => setPreviewVideo(null)}
      />
    </div>
  );
}
