"use client";

import { useEffect, useRef } from "react";

export default function ArticleContentDisclosure({ content, collapsed }: { content: string; collapsed: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const body = contentRef.current;
    if (!collapsed || !viewport || !body) return;

    const concealed = new Set<HTMLElement>();
    const restoreAccessibility = () => {
      for (const element of concealed) {
        element.removeAttribute("inert");
        element.removeAttribute("aria-hidden");
      }
      concealed.clear();
    };
    const measure = () => {
      restoreAccessibility();
      const height = Math.ceil(body.getBoundingClientRect().height * 2 / 3);
      viewport.style.maxHeight = `${height}px`;
      const cutoff = body.getBoundingClientRect().top + height;
      // Clipped links must not be reachable with Tab; fully hidden blocks must
      // not remain in the accessibility tree. Sanitized HTML has no prior inert
      // or aria-hidden attributes to preserve.
      for (const element of body.querySelectorAll<HTMLElement>("p,h1,h2,h3,blockquote,pre,ul,ol,li,img,a,hr")) {
        const bounds = element.getBoundingClientRect();
        const crossesCutoff = bounds.bottom > cutoff && !["UL", "OL", "BLOCKQUOTE"].includes(element.tagName);
        if (bounds.top >= cutoff || crossesCutoff) {
          element.setAttribute("inert", "");
          element.setAttribute("aria-hidden", "true");
          concealed.add(element);
        }
      }
    };

    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(body);
    // Also covers older browsers without ResizeObserver and delayed OSS images.
    body.addEventListener("load", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      body.removeEventListener("load", measure, true);
      window.removeEventListener("resize", measure);
      viewport.style.maxHeight = "";
      restoreAccessibility();
    };
  }, [collapsed, content]);

  return (
    <div
      ref={viewportRef}
      id="article-readable-content"
      className={`published-content-viewport${collapsed ? " is-collapsed" : ""}`}
      data-collapsed={collapsed}
    >
      <div ref={contentRef} className="published-content" dangerouslySetInnerHTML={{ __html: content }} />
    </div>
  );
}
