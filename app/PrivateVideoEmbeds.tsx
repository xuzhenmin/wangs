"use client";

import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { isPrivateVideoId, PRIVATE_VIDEO_ATTRIBUTE } from "../lib/private-video-reference";
import PrivateVideoPlayer from "./PrivateVideoPlayer";

/** Sanitized HTML is already rendered; create DOM hosts, never interpolate HTML. */
export default function PrivateVideoEmbeds({ containerRef, content }: { containerRef: RefObject<HTMLDivElement | null>; content: string }) {
  const [hosts, setHosts] = useState<{ host: HTMLDivElement; original: HTMLVideoElement; assetId: string; title: string }[]>([]);
  useEffect(() => {
    let alive = true;
    const found: typeof hosts = [];
    containerRef.current?.querySelectorAll<HTMLVideoElement>(`video[${PRIVATE_VIDEO_ATTRIBUTE}]`).forEach(original => {
      const assetId = original.getAttribute(PRIVATE_VIDEO_ATTRIBUTE);
      if (!isPrivateVideoId(assetId)) return;
      const host = document.createElement("div");
      host.dataset.privateVideoHost = assetId;
      original.replaceWith(host);
      found.push({ host, original, assetId, title: original.title || "私密视频" });
    });
    queueMicrotask(() => { if (alive) setHosts(found); });
    return () => { alive = false; for (const entry of found) entry.host.replaceWith(entry.original); };
  }, [containerRef, content]);
  return hosts.map(({ host, assetId, title }, index) => createPortal(<PrivateVideoPlayer assetId={assetId} title={title} />, host, `${assetId}:${index}`));
}
