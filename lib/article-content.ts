import sanitizeHtml from "sanitize-html";
import { isDisplayableArticleImageSource } from "./article-image-urls";

export function safeArticleContent(articleId: string, content: string) {
  return sanitizeHtml(content, {
    allowedTags: ["p", "br", "h1", "h2", "h3", "strong", "em", "u", "s", "code", "pre", "blockquote", "ul", "ol", "li", "hr", "a", "img"],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "title"],
      p: ["style"],
      h1: ["style"],
      h2: ["style"],
      h3: ["style"],
    },
    allowedStyles: { "*": { "text-align": [/^(left|center|right|justify)$/] } },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    exclusiveFilter: (frame) => frame.tag === "img"
      && !isDisplayableArticleImageSource(articleId, frame.attribs.src || ""),
    transformTags: {
      a: (_tagName, attribs) => {
        const external = /^https?:\/\//i.test(attribs.href || "");
        return {
          tagName: "a",
          attribs: external ? { ...attribs, target: "_blank", rel: "noreferrer noopener nofollow" } : attribs,
        };
      },
    },
  });
}

