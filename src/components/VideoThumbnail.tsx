import { useState } from 'react';
import { Film } from 'lucide-react';

interface VideoThumbnailProps {
  src: string;
  alt: string;
  className?: string;
}

export function VideoThumbnail({ src, alt, className = '' }: VideoThumbnailProps) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 text-slate-400 ${className}`}
        aria-label={alt}
      >
        <Film className="h-4 w-4 shrink-0" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`object-cover bg-slate-100 ${className}`}
    />
  );
}
