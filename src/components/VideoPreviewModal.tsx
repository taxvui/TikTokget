import { useEffect, useState } from 'react';
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Loader2,
  X,
} from 'lucide-react';
import type { ResolveVideoResponse, TikTokVideoItem } from '../types';
import { formatCompactNumber, formatDateVi, formatDuration } from '../utils/exportUtils';

interface VideoPreviewModalProps {
  video: TikTokVideoItem | null;
  username?: string;
  onClose: () => void;
}

export function VideoPreviewModal({ video, username, onClose }: VideoPreviewModalProps) {
  const [copied, setCopied] = useState(false);
  const [copiedImgLinks, setCopiedImgLinks] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [resolvedPhoto, setResolvedPhoto] = useState<ResolveVideoResponse | null>(null);
  const [loadingPhoto, setLoadingPhoto] = useState(false);
  const [slideIdx, setSlideIdx] = useState(0);

  const isExplicitPhoto = Boolean(
    video && (video.mediaType === 'image' || /\/photo\/\d+/i.test(video.url))
  );

  useEffect(() => {
    setVideoError(false);
    setResolvedPhoto(null);
    setSlideIdx(0);
    setCopiedImgLinks(false);
  }, [video?.id]);

  useEffect(() => {
    if (!video) return;
    if (!isExplicitPhoto && !videoError) return;
    if (resolvedPhoto?.video.id === video.id) return;

    let cancelled = false;
    setLoadingPhoto(true);
    fetch('/api/resolve-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: video.url }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ResolveVideoResponse | null) => {
        if (!cancelled && data && data.mediaType === 'image' && data.images.length > 0) {
          setResolvedPhoto(data);
          setSlideIdx(0);
        }
      })
      .catch(() => {
        // Ignore fallback failure
      })
      .finally(() => {
        if (!cancelled) setLoadingPhoto(false);
      });

    return () => {
      cancelled = true;
    };
  }, [video, isExplicitPhoto, videoError, resolvedPhoto?.video.id]);

  useEffect(() => {
    if (!video) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (resolvedPhoto && resolvedPhoto.images.length > 1) {
        if (e.key === 'ArrowRight') {
          setSlideIdx((prev) => (prev + 1) % resolvedPhoto.images.length);
        } else if (e.key === 'ArrowLeft') {
          setSlideIdx(
            (prev) => (prev - 1 + resolvedPhoto.images.length) % resolvedPhoto.images.length
          );
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [video, onClose, resolvedPhoto]);

  if (!video) return null;

  const isPhotoMode = Boolean(resolvedPhoto && resolvedPhoto.images.length > 0);
  const currentImg = isPhotoMode ? resolvedPhoto!.images[slideIdx] || resolvedPhoto!.images[0] : null;

  const streamUrl = `/api/media/video/${encodeURIComponent(video.id)}?u=${encodeURIComponent(
    username || 'tiktok'
  )}`;
  const downloadUrl = `${streamUrl}&download=1`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(video.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked
    }
  };

  const handleCopyAllImageLinks = async () => {
    if (!resolvedPhoto || resolvedPhoto.images.length === 0) return;
    try {
      await navigator.clipboard.writeText(
        resolvedPhoto.images.map((img) => img.cdnUrl).join('\n')
      );
      setCopiedImgLinks(true);
      setTimeout(() => setCopiedImgLinks(false), 1800);
    } catch {
      // Clipboard blocked
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-[2px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-modal-title"
    >
      <div
        className="relative flex w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl md:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-rose-600"
          aria-label="Đóng xem trước"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="relative flex shrink-0 flex-col items-center justify-center bg-slate-950 md:w-[380px]">
          {loadingPhoto ? (
            <div className="flex h-[440px] w-full flex-col items-center justify-center gap-3 text-slate-300 md:h-[580px]">
              <Loader2 className="h-7 w-7 animate-spin text-rose-500" />
              <span className="text-xs">Đang tách danh sách ảnh gốc...</span>
            </div>
          ) : isPhotoMode && currentImg ? (
            <div className="relative flex h-[440px] w-full flex-col justify-between bg-slate-950 md:h-[580px]">
              <div className="relative flex flex-1 items-center justify-center overflow-hidden">
                <img
                  src={currentImg.proxyUrl}
                  alt={`${video.title} - Ảnh ${currentImg.index}`}
                  className="max-h-full max-w-full object-contain"
                />

                {resolvedPhoto!.images.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        setSlideIdx(
                          (prev) =>
                            (prev - 1 + resolvedPhoto!.images.length) %
                            resolvedPhoto!.images.length
                        )
                      }
                      aria-label="Ảnh trước"
                      className="absolute left-2.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg bg-slate-950/75 text-white hover:bg-slate-900"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSlideIdx((prev) => (prev + 1) % resolvedPhoto!.images.length)
                      }
                      aria-label="Ảnh tiếp theo"
                      className="absolute right-2.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg bg-slate-950/75 text-white hover:bg-slate-900"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </>
                )}

                <div className="absolute left-3 top-3 rounded-md bg-slate-950/80 px-2.5 py-1 font-mono text-xs font-medium text-white tabular-nums">
                  {currentImg.index} / {resolvedPhoto!.images.length}
                  {currentImg.width && currentImg.height
                    ? ` · ${currentImg.width}×${currentImg.height}`
                    : ''}
                </div>
              </div>

              {resolvedPhoto!.images.length > 1 && (
                <div className="flex gap-1.5 overflow-x-auto border-t border-slate-800 bg-slate-900/90 p-2">
                  {resolvedPhoto!.images.map((img, i) => (
                    <button
                      key={img.index}
                      type="button"
                      onClick={() => setSlideIdx(i)}
                      className={`h-12 w-10 shrink-0 overflow-hidden rounded border-2 transition-all ${
                        i === slideIdx
                          ? 'border-rose-500 opacity-100'
                          : 'border-transparent opacity-60 hover:opacity-100'
                      }`}
                    >
                      <img
                        src={img.proxyUrl}
                        alt={`Ảnh ${img.index}`}
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : videoError || isExplicitPhoto ? (
            <div className="flex h-[440px] w-full flex-col items-center justify-center gap-3 px-6 text-center text-slate-300 md:h-[580px]">
              <Film className="h-8 w-8 text-slate-500" />
              <p className="text-sm font-medium text-white">
                Không thể phát luồng trực tiếp cho mục này
              </p>
              <p className="text-xs text-slate-400">
                Bạn vẫn có thể sao chép liên kết hoặc mở trực tiếp trên TikTok.
              </p>
              <a
                href={video.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-medium text-white hover:bg-rose-700"
              >
                <span>Mở trên TikTok</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          ) : (
            <video
              key={video.id}
              src={streamUrl}
              poster={video.thumbnailUrl}
              controls
              playsInline
              autoPlay
              onError={() => setVideoError(true)}
              className="h-[440px] w-full bg-black object-contain md:h-[580px]"
            />
          )}
        </div>

        <div className="flex flex-1 flex-col justify-between p-6">
          <div className="space-y-4">
            <div className="pr-8">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-mono tabular-nums">ID: {video.id}</span>
                {isPhotoMode && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1 font-medium text-rose-600">
                      <ImageIcon className="h-3.5 w-3.5" />
                      <span>Bộ {resolvedPhoto!.images.length} ảnh</span>
                    </span>
                  </>
                )}
                {video.pinned && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-medium text-rose-600">Đã ghim</span>
                  </>
                )}
              </div>
              <h3
                id="preview-modal-title"
                className="mt-2 text-base font-semibold leading-snug text-slate-900"
              >
                {video.title}
              </h3>
            </div>

            {video.description && video.description !== video.title && (
              <p className="max-h-28 overflow-y-auto text-sm leading-relaxed text-slate-600">
                {video.description}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 border-y border-slate-100 py-4 text-sm">
              <div>
                <div className="text-xs text-slate-500">Lượt xem</div>
                <div className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                  {formatCompactNumber(video.views)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Lượt thích</div>
                <div className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                  {formatCompactNumber(video.likes)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Bình luận</div>
                <div className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                  {formatCompactNumber(video.comments)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">
                  {isPhotoMode ? 'Ngày đăng · Số ảnh' : 'Ngày đăng · Thời lượng'}
                </div>
                <div className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                  {formatDateVi(video.createdAt)} ·{' '}
                  {isPhotoMode
                    ? `${resolvedPhoto!.images.length} ảnh`
                    : formatDuration(video.durationSec)}
                </div>
              </div>
            </div>

            {isPhotoMode && currentImg ? (
              <div>
                <div className="flex items-center justify-between text-xs font-medium text-slate-500">
                  <span>Link ảnh gốc đang xem (#{currentImg.index})</span>
                  <a
                    href={currentImg.downloadUrl}
                    download={`tiktok_${video.id}_anh_${currentImg.index}.${currentImg.format}`}
                    className="text-rose-600 hover:text-rose-700"
                  >
                    Tải riêng ảnh #{currentImg.index}
                  </a>
                </div>
                <div className="mt-1.5 max-h-16 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-700 break-all">
                  {currentImg.cdnUrl}
                </div>
              </div>
            ) : (
              <div>
                <div className="text-xs font-medium text-slate-500">Đường dẫn bài đăng</div>
                <div className="mt-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700 break-all">
                  {video.url}
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            {isPhotoMode && resolvedPhoto!.zipDownloadUrl ? (
              <>
                <a
                  href={resolvedPhoto!.zipDownloadUrl}
                  download={`tiktok_${video.id}_${resolvedPhoto!.images.length}_anh.zip`}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  <Archive className="h-4 w-4" />
                  <span>Tải tất cả (.ZIP)</span>
                </a>
                <button
                  type="button"
                  onClick={handleCopyAllImageLinks}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 whitespace-nowrap shrink-0"
                >
                  {copiedImgLinks ? (
                    <Check className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  <span>
                    {copiedImgLinks
                      ? `Đã chép ${resolvedPhoto!.images.length} link ảnh`
                      : `Chép ${resolvedPhoto!.images.length} link ảnh`}
                  </span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-rose-600"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  <span>{copied ? 'Đã sao chép link' : 'Sao chép link'}</span>
                </button>

                <a
                  href={downloadUrl}
                  download={`tiktok_${video.id}.mp4`}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 whitespace-nowrap shrink-0"
                >
                  <Download className="h-4 w-4" />
                  <span>Tải .MP4</span>
                </a>
              </>
            )}

            <a
              href={video.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 whitespace-nowrap shrink-0"
            >
              <span>Mở TikTok</span>
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
