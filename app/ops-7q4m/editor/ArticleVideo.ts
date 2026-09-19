import { Node } from "@tiptap/react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import PrivateVideoPlayer from "../../PrivateVideoPlayer";
import { isPrivateVideoId, PRIVATE_VIDEO_ATTRIBUTE } from "../../../lib/private-video-reference";

const videoPath = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/video\.mp4$/;

/** Only this site's configured OSS video namespace is playable in the editor. */
export function isArticleVideoUrl(value: unknown, base: string | null | undefined): value is string {
  if (typeof value !== "string" || !base || value !== value.trim()) return false;
  try {
    const source = new URL(value);
    const prefix = new URL(base);
    if (source.protocol !== "https:" || prefix.protocol !== "https:" || source.username || source.password || source.search || source.hash || prefix.username || prefix.password || prefix.search || prefix.hash) return false;
    const allowedPrefix = `${prefix.href.replace(/\/$/, "")}/`;
    return source.href === value && source.href.startsWith(allowedPrefix) && videoPath.test(source.href.slice(allowedPrefix.length));
  } catch { return false; }
}

export const ArticleVideo = Node.create<{ articleVideoBaseUrl: string | null }>({
  name: "articleVideo",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() { return { articleVideoBaseUrl: null }; },
  addAttributes() {
    return {
      src: { default: "", parseHTML: element => element.getAttribute("src") || element.querySelector("source[src]")?.getAttribute("src") || "" },
      assetId: { default: "", parseHTML: element => element.getAttribute(PRIVATE_VIDEO_ATTRIBUTE) || "" },
      title: { default: "", parseHTML: element => element.getAttribute("title") || "" },
    };
  },
  parseHTML() { return [{ tag: "video" }]; },
  // Preserve unsupported draft URLs for server-side validation without loading them.
  // The editor and preview both use the safe node view below, not this serializer.
  renderHTML({ node }) {
    return ["video", {
      ...(isPrivateVideoId(node.attrs.assetId) ? { [PRIVATE_VIDEO_ATTRIBUTE]: node.attrs.assetId } : { src: node.attrs.src }),
      ...(node.attrs.title ? { title: node.attrs.title } : {}),
      controls: "",
      playsinline: "",
      preload: "metadata",
    }];
  },
  addNodeView() {
    const base = this.options.articleVideoBaseUrl;
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "rich-article-video";
      dom.contentEditable = "false";
      dom.dataset.type = "article-video";
      let playerRoot: Root | null = null;
      const render = (src: unknown, title: unknown, assetId: unknown) => {
        const oldRoot = playerRoot; playerRoot = null;
        if (oldRoot) queueMicrotask(() => oldRoot.unmount());
        const previousVideo = dom.querySelector("video");
        if (previousVideo) { previousVideo.pause(); previousVideo.removeAttribute("src"); previousVideo.load(); }
        dom.replaceChildren();
        if (isPrivateVideoId(assetId)) {
          const host = document.createElement("div");
          dom.append(host);
          playerRoot = createRoot(host);
          playerRoot.render(createElement(PrivateVideoPlayer, { assetId, title: typeof title === "string" && title ? title : "私密视频", admin: true }));
        } else if (isArticleVideoUrl(src, base)) {
          const video = document.createElement("video");
          video.src = src;
          video.controls = true;
          video.playsInline = true;
          video.preload = "metadata";
          if (typeof title === "string" && title) video.title = title;
          dom.append(video);
        } else {
          const placeholder = document.createElement("p");
          placeholder.className = "article-video-unavailable";
          placeholder.setAttribute("role", "note");
          placeholder.textContent = "视频暂不可预览：请从视频库选择已上传至本站 OSS 的视频。";
          dom.append(placeholder);
        }
      };
      render(node.attrs.src, node.attrs.title, node.attrs.assetId);
      return {
        dom,
        update(nextNode) {
          if (nextNode.type !== node.type) return false;
          if (nextNode.attrs.src !== node.attrs.src || nextNode.attrs.title !== node.attrs.title || nextNode.attrs.assetId !== node.attrs.assetId) render(nextNode.attrs.src, nextNode.attrs.title, nextNode.attrs.assetId);
          node = nextNode;
          return true;
        },
        selectNode() { dom.classList.add("ProseMirror-selectednode"); },
        deselectNode() { dom.classList.remove("ProseMirror-selectednode"); },
        stopEvent: event => event.target instanceof HTMLElement && (!!node.attrs.assetId || event.target instanceof HTMLVideoElement),
        destroy() {
          const oldRoot = playerRoot; playerRoot = null;
          if (oldRoot) queueMicrotask(() => oldRoot.unmount());
          const video = dom.querySelector("video");
          if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
        },
      };
    };
  },
});
