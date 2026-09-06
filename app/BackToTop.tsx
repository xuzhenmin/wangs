"use client";

export default function BackToTop() {
  return (
    <button
      className="back-to-top"
      type="button"
      aria-label="返回顶部"
      title="返回顶部"
      onClick={() => window.scrollTo({
        top: 0,
        left: 0,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      })}
    >
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M5 4h14M6 13l6-6 6 6M12 7v13" />
      </svg>
    </button>
  );
}
