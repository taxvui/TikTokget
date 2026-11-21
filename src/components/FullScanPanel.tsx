import { useRef, useState, type ChangeEvent } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  FileUp,
  Link2,
  Loader2,
  Play,
  Shield,
  Sparkles,
  Square,
  Upload,
} from 'lucide-react';
import type { TikTokVideoItem } from '../types';
import { buildConsoleExtractorScript } from '../utils/exportUtils';

interface FullScanPanelProps {
  username: string;
  scannedCount: number;
  totalProfileCount: number;
  onImportVideos: (items: TikTokVideoItem[]) => number;
  onEnrichImported: () => Promise<void>;
  isEnriching: boolean;
}

interface DeepScanStreamEvent {
  type: 'status' | 'items' | 'complete' | 'error';
  message?: string;
  videos?: TikTokVideoItem[];
  collected?: number;
  batches?: number;
  stopReason?: 'completed' | 'guest_limit' | 'aborted' | 'stalled';
  error?: string;
}

export function FullScanPanel({
  username,
  scannedCount,
  totalProfileCount,
  onImportVideos,
  onEnrichImported,
  isEnriching,
}: FullScanPanelProps) {
  const [activeTab, setActiveTab] = useState<'auto_cdp' | 'script' | 'paste'>('auto_cdp');
  const [scriptCopied, setScriptCopied] = useState(false);
  const [rawInput, setRawInput] = useState('');
  const [importing, setImporting] = useState(false);

  const [cookieInput, setCookieInput] = useState('');
  const [proxyInput, setProxyInput] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isAutoScanning, setIsAutoScanning] = useState(false);
  const [autoStatus, setAutoStatus] = useState<string | null>(null);
  const [autoCollected, setAutoCollected] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const consoleScript = buildConsoleExtractorScript(username);

  const handleStartAutoScan = async () => {
    if (isAutoScanning) {
      abortRef.current?.abort();
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsAutoScanning(true);
    setFeedback(null);
    setAutoCollected(0);
    setAutoStatus('Đang khởi tạo Chrome CDP thuần (không bật Runtime.enable)...');

    let addedTotal = 0;

    try {
      const res = await fetch('/api/deep-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: username,
          cookie: cookieInput.trim() || undefined,
          proxy: proxyInput.trim() || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errJson.error || `Lỗi HTTP ${res.status} khi chạy trình cào CDP.`);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error('Trình duyệt không hỗ trợ đọc luồng tiến độ trực tiếp.');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const ev = JSON.parse(trimmed) as DeepScanStreamEvent;
            if (ev.type === 'status' && ev.message) {
              setAutoStatus(ev.message);
              if (typeof ev.collected === 'number') setAutoCollected(ev.collected);
            } else if (ev.type === 'items' && Array.isArray(ev.videos)) {
              const added = onImportVideos(ev.videos);
              addedTotal += added;
              if (typeof ev.collected === 'number') setAutoCollected(ev.collected);
            } else if (ev.type === 'complete') {
              setAutoStatus(null);
              if (typeof ev.collected === 'number') setAutoCollected(ev.collected);
              setFeedback({
                type: ev.stopReason === 'guest_limit' ? 'error' : 'success',
                text: `${ev.message || 'Hoàn tất quét tự động.'} (Đã gộp thêm ${addedTotal} bài mới vào danh sách.)`,
              });
            } else if (ev.type === 'error') {
              throw new Error(ev.error || 'Lỗi trình cào Chrome CDP.');
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
              if (!parseErr.message.includes('JSON')) throw parseErr;
            }
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setAutoStatus(null);
        setFeedback({
          type: 'success',
          text: `Đã dừng quét tự động. Đã gộp thêm ${addedTotal} bài đăng mới vào danh sách.`,
        });
      } else {
        setAutoStatus(null);
        setFeedback({
          type: 'error',
          text: err instanceof Error ? err.message : 'Lỗi kết nối trình cào Chrome CDP.',
        });
      }
    } finally {
      abortRef.current = null;
      setIsAutoScanning(false);
    }
  };

  const handleCopyScript = async () => {
    try {
      await navigator.clipboard.writeText(consoleScript);
      setScriptCopied(true);
      setTimeout(() => setScriptCopied(false), 2000);
    } catch {
      setFeedback({
        type: 'error',
        text: 'Trình duyệt không cho phép truy cập Clipboard tự động. Vui lòng bôi đen và sao chép thủ công.',
      });
    }
  };

  const processRawText = async (textToParse: string) => {
    if (!textToParse.trim()) {
      setFeedback({ type: 'error', text: 'Vui lòng dán JSON hoặc danh sách link trước khi nhập.' });
      return;
    }

    setImporting(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: textToParse, username }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Không thể phân tích dữ liệu.');
      }
      const addedCount = onImportVideos(data.videos || []);
      setRawInput('');
      setFeedback({
        type: 'success',
        text: `Đã phân tích ${data.parsedCount} bài đăng và thêm mới ${addedCount} link chưa trùng vào danh sách.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Lỗi nhập dữ liệu.',
      });
    } finally {
      setImporting(false);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRawInput(text.slice(0, 8000));
    await processRawText(text);
    e.target.value = '';
  };

  const remaining = Math.max(0, totalProfileCount - scannedCount);

  return (
    <section
      id="full-scan"
      className="rounded-xl border border-slate-200 bg-white p-6"
      aria-labelledby="full-scan-heading"
    >
      <div className="flex flex-col gap-4 border-b border-slate-100 pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 id="full-scan-heading" className="text-base font-semibold text-slate-900">
            Thu thập toàn bộ {totalProfileCount > 0 ? totalProfileCount.toLocaleString('vi-VN') : ''}{' '}
            bài đăng của @{username}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {remaining > 0
              ? `Trang đầu công khai đang có ${scannedCount} bài. Dùng chế độ Quét tự động (Chrome CDP kiểu Nodriver) ngay tại đây mà không cần mở DevTools, hoặc chạy Script trình duyệt nếu cần.`
              : `Bạn đã thu thập đầy đủ toàn bộ bài đăng hiện có trên kênh @${username}.`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 self-start rounded-lg bg-slate-100 p-1 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('auto_cdp')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'auto_cdp'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Bot className="h-3.5 w-3.5 text-rose-600" />
            <span>Quét tự động (CDP)</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('script')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'script'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
            <span>Script trình duyệt</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('paste')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'paste'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Link2 className="h-3.5 w-3.5" />
            <span>Nhập JSON / Link</span>
          </button>
        </div>
      </div>

      {activeTab === 'auto_cdp' ? (
        <div className="mt-5 space-y-4">
          <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Shield className="h-4 w-4 text-rose-600" />
                <span>Trình cào Chrome CDP ẩn (không bật Runtime.enable, không cần DevTools)</span>
              </div>
              <p className="text-xs leading-relaxed text-slate-600">
                Server tự mở Chromium thực, cuộn trang bằng sự kiện chuột CDP và bắt trực tiếp API{' '}
                <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px] border border-slate-200">
                  /api/post/item_list
                </code>
                . Ở chế độ khách không Cookie, TikTok thường giới hạn ~67 bài; dán thêm Cookie phiên TikTok bên dưới để cuộn sâu tới 100%.
              </p>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={handleStartAutoScan}
                className={`inline-flex h-10 items-center gap-2 rounded-lg px-5 text-sm font-semibold text-white transition-colors whitespace-nowrap shrink-0 ${
                  isAutoScanning
                    ? 'bg-slate-900 hover:bg-slate-800'
                    : 'bg-rose-600 hover:bg-rose-700'
                }`}
              >
                {isAutoScanning ? (
                  <>
                    <Square className="h-3.5 w-3.5 fill-white" />
                    <span>Dừng quét ({autoCollected})</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5 fill-white" />
                    <span>Bắt đầu quét tự động</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {isAutoScanning && autoStatus && (
            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-700">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-rose-600" />
              <span className="flex-1">{autoStatus}</span>
              <span className="font-mono font-semibold text-slate-900 tabular-nums">
                {autoCollected} bài
              </span>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 bg-white">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <span>
                Tuỳ chọn nâng cao: Cookie TikTok & Proxy (tuỳ chọn — giúp vượt giới hạn ~67 bài)
              </span>
              {showAdvanced ? (
                <ChevronUp className="h-4 w-4 text-slate-400" />
              ) : (
                <ChevronDown className="h-4 w-4 text-slate-400" />
              )}
            </button>

            {showAdvanced && (
              <div className="grid gap-4 border-t border-slate-100 p-4 lg:grid-cols-12">
                <div className="space-y-1.5 lg:col-span-7">
                  <label
                    htmlFor="tiktok-cookie-input"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Cookie phiên TikTok (hỗ trợ chuỗi Header <code className="font-mono">sessionid=...; ...</code>, JSON Cookie-Editor hoặc <code className="font-mono">cookies.txt</code>)
                  </label>
                  <textarea
                    id="tiktok-cookie-input"
                    rows={3}
                    value={cookieInput}
                    onChange={(e) => setCookieInput(e.target.value)}
                    placeholder="Dán Cookie TikTok tại đây (chỉ dùng trong RAM cho phiên quét này, không lưu trữ)..."
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-slate-800 placeholder:text-slate-400 focus:border-rose-500 focus:bg-white focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5 lg:col-span-5">
                  <label
                    htmlFor="tiktok-proxy-input"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Proxy HTTP / SOCKS5 (tuỳ chọn)
                  </label>
                  <input
                    id="tiktok-proxy-input"
                    type="text"
                    value={proxyInput}
                    onChange={(e) => setProxyInput(e.target.value)}
                    placeholder="http://user:pass@ip:port hoặc socks5://ip:port"
                    className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-xs text-slate-800 placeholder:text-slate-400 focus:border-rose-500 focus:bg-white focus:outline-none"
                  />
                  <p className="text-[11px] text-slate-500">
                    Nếu dùng IP dân cư hoặc Cookie đăng nhập, Chrome CDP sẽ cuộn qua toàn bộ danh sách video không bị TikTok chặn khách vãng lai.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : activeTab === 'script' ? (
        <div className="mt-5 grid gap-6 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-7">
            <ol className="space-y-2.5 text-sm text-slate-700">
              <li className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-slate-100 font-mono text-xs font-semibold text-slate-700 tabular-nums">
                  1
                </span>
                <span>
                  Mở trang{' '}
                  <a
                    href={`https://www.tiktok.com/@${username}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-rose-600 underline decoration-rose-200 underline-offset-2 hover:text-rose-700"
                  >
                    tiktok.com/@{username}
                  </a>{' '}
                  trên trình duyệt và nhấn <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-xs">F12</kbd> → chọn tab <strong>Console</strong>.
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-slate-100 font-mono text-xs font-semibold text-slate-700 tabular-nums">
                  2
                </span>
                <span>
                  Nhấn <strong>Sao chép Script</strong> bên phải, dán vào Console và nhấn Enter (nếu trình duyệt yêu cầu, gõ <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">allow pasting</code> trước).
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-slate-100 font-mono text-xs font-semibold text-slate-700 tabular-nums">
                  3
                </span>
                <span>
                  Script sẽ tự cuộn trang, bắt toàn bộ dữ liệu API bài đăng của @{username} và tải xuống tệp{' '}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
                    {username}_all_videos.json
                  </code>
                  . Tải tệp đó lên đây để gộp vào bảng.
                </span>
              </li>
            </ol>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={handleCopyScript}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                {scriptCopied ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                <span>{scriptCopied ? 'Đã sao chép Script' : 'Sao chép Script quét toàn bộ'}</span>
              </button>

              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 whitespace-nowrap shrink-0">
                <FileUp className="h-4 w-4" />
                <span>Tải lên tệp JSON vừa xuất</span>
                <input
                  type="file"
                  accept=".json,.txt,.html"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>

              <button
                type="button"
                onClick={() => setActiveTab('paste')}
                className="inline-flex items-center gap-1.5 px-2 py-2 text-sm font-medium text-slate-600 transition-colors hover:text-slate-900 whitespace-nowrap shrink-0"
              >
                <span>Hoặc dán trực tiếp →</span>
              </button>
            </div>
          </div>

          <div className="lg:col-span-5">
            <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-slate-950">
              <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-xs text-slate-400">
                <span className="font-mono">devtools-extractor.js</span>
                <button
                  type="button"
                  onClick={handleCopyScript}
                  className="text-xs font-medium text-slate-300 hover:text-white whitespace-nowrap shrink-0"
                >
                  {scriptCopied ? 'Đã chép' : 'Sao chép'}
                </button>
              </div>
              <pre className="max-h-44 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                {consoleScript}
              </pre>
            </div>
          </div>
        </div>
      ) : (
        <div id="import-data" className="mt-5 space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-600">
              Dán mảng JSON từ Script, mã nguồn HTML trang TikTok, hoặc danh sách các link video/ảnh (mỗi dòng 1 link).
            </p>
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-rose-600 hover:text-rose-700 whitespace-nowrap shrink-0">
              <Upload className="h-4 w-4" />
              <span>Chọn tệp .json / .txt / .html</span>
              <input
                type="file"
                accept=".json,.txt,.html"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>

          <textarea
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            rows={5}
            placeholder={`Dán JSON hoặc danh sách link tại đây...\nVí dụ:\nhttps://www.tiktok.com/@${username}/video/7661204077338021141\nhttps://www.tiktok.com/@${username}/photo/7661204077338021141`}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-800 placeholder:text-slate-400 focus:border-rose-500 focus:bg-white focus:outline-none"
          />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={importing}
              onClick={() => processRawText(rawInput)}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <span>{importing ? 'Đang phân tích...' : 'Phân tích & Gộp link'}</span>
            </button>

            <button
              type="button"
              disabled={isEnriching}
              onClick={onEnrichImported}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Sparkles className="h-4 w-4 text-slate-500" />
              <span>
                {isEnriching
                  ? 'Đang lấy tiêu đề oEmbed...'
                  : 'Bổ sung tiêu đề cho link mới nhập'}
              </span>
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div
          className={`mt-4 rounded-lg border px-4 py-2.5 text-sm ${
            feedback.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          {feedback.text}
        </div>
      )}
    </section>
  );
}
