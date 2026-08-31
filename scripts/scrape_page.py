#!/usr/bin/env python3
"""Save readable text, structure, and images from one web page."""

from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import json
import re
import socket
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib import error, parse, request, robotparser


USER_AGENT = "WangsPageArchiver/2.0"
MAX_HTML_BYTES = 5 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 100 * 1024 * 1024
TIMEOUT_SECONDS = 15
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
BLOCKED_TAGS = {"script", "style", "noscript", "iframe", "video", "audio", "canvas", "form", "dialog", "template"}
BLOCK_TAGS = {"article", "aside", "blockquote", "div", "footer", "h1", "h2", "h3", "h4", "header", "li", "main", "nav", "p", "section", "table", "tr"}
AD_MARKERS = {
    "ad", "ads", "advert", "advertisement", "affiliate", "casino", "commercial",
    "modal", "popup", "promo", "promotion", "sponsor", "sponsored",
}
IMAGE_SOURCE_ATTRIBUTES = ("src", "data-src", "data-original", "data-lazy-src", "data-url")
PRIMARY_CONTENT_MARKERS = (
    "article-body", "article-txt-content", "detail-content",
    "entry-content", "post-content", "rich-content", "rich-text",
)
IMAGE_EXTENSIONS = {
    "image/avif": ".avif", "image/bmp": ".bmp", "image/gif": ".gif",
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/svg+xml": ".svg", "image/webp": ".webp",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="抓取单个公开网页，保存清洗后的文本、Markdown、JSON 和页面图片。"
    )
    parser.add_argument("url", nargs="?", help="要保存的 http(s) 页面网址；省略时会交互询问")
    parser.add_argument("--output", default="scraped-pages", help="保存目录，默认 scraped-pages")
    parser.add_argument("--no-images", action="store_true", help="只保存文字，不下载图片")
    parser.add_argument("--max-images", type=int, default=100, help="单页最多下载的图片数，默认 100，最大 200")
    parser.add_argument("--max-image-mb", type=int, default=12, help="单张图片大小上限，默认 12 MB，最大 50 MB")
    parser.add_argument(
        "--allow-private", action="store_true",
        help="允许 localhost 或内网地址，仅用于你控制的本地开发环境",
    )
    args = parser.parse_args()
    if not 1 <= args.max_images <= 200:
        parser.error("--max-images 必须在 1 到 200 之间")
    if not 1 <= args.max_image_mb <= 50:
        parser.error("--max-image-mb 必须在 1 到 50 之间")
    return args


def normalized_url(value: str) -> str:
    value = value.strip()
    parsed = parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("只支持完整的 http:// 或 https:// 页面网址。")
    if parsed.username or parsed.password:
        raise ValueError("网址中不能包含用户名或密码。")
    return value


def ensure_safe_host(url: str, allow_private: bool) -> None:
    if allow_private:
        return
    host = parse.urlsplit(url).hostname
    if not host:
        raise ValueError("网址缺少有效主机名。")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, None)}
    except socket.gaierror as exc:
        raise ValueError(f"无法解析主机名：{host}") from exc
    for address in addresses:
        if not ipaddress.ip_address(address).is_global:
            raise ValueError("默认禁止访问 localhost、内网或保留地址；本地测试可加 --allow-private。")


class SafeRedirectHandler(request.HTTPRedirectHandler):
    def __init__(self, allow_private: bool) -> None:
        super().__init__()
        self.allow_private = allow_private

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        normalized_url(newurl)
        ensure_safe_host(newurl, self.allow_private)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def build_opener(allow_private: bool) -> request.OpenerDirector:
    return request.build_opener(SafeRedirectHandler(allow_private))


def allowed_by_robots(url: str, allow_private: bool) -> bool:
    robots_url = parse.urljoin(url, "/robots.txt")
    robots = robotparser.RobotFileParser()
    robots.set_url(robots_url)
    try:
        robots_request = request.Request(robots_url, headers={"User-Agent": USER_AGENT})
        with build_opener(allow_private).open(robots_request, timeout=TIMEOUT_SECONDS) as response:
            raw_lines = response.read(512 * 1024).decode("utf-8", errors="replace").splitlines()
        robots.parse(raw_lines)
    except (error.URLError, OSError):
        print("提示：robots.txt 暂时无法读取，将按单页、低频模式继续。", file=sys.stderr)
        return True
    return robots.can_fetch(USER_AGENT, url)


def fetch_html(url: str, allow_private: bool) -> tuple[str, str]:
    ensure_safe_host(url, allow_private)
    if not allowed_by_robots(url, allow_private):
        raise PermissionError("robots.txt 不允许此工具访问该页面。")
    page_request = request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
        },
    )
    with build_opener(allow_private).open(page_request, timeout=TIMEOUT_SECONDS) as response:
        final_url = response.geturl()
        ensure_safe_host(final_url, allow_private)
        content_type = response.headers.get_content_type()
        if content_type not in {"text/html", "application/xhtml+xml"}:
            raise ValueError(f"目标不是 HTML 页面：{content_type}")
        raw = response.read(MAX_HTML_BYTES + 1)
        if len(raw) > MAX_HTML_BYTES:
            raise ValueError("页面超过 5 MB 安全上限，已停止保存。")
        charset = response.headers.get_content_charset() or "utf-8"
        try:
            return raw.decode(charset, errors="replace"), final_url
        except LookupError:
            return raw.decode("utf-8", errors="replace"), final_url


def has_ad_marker(attrs: list[tuple[str, str | None]]) -> bool:
    values: list[str] = []
    for key, value in attrs:
        if key.lower() in {"class", "id", "role", "aria-label", "data-ad", "data-ad-slot"} and value:
            values.append(value.lower())
    tokens = set(re.split(r"[^a-z0-9\u4e00-\u9fff]+", " ".join(values)))
    return bool(tokens & AD_MARKERS)


def source_from_srcset(value: str) -> str:
    candidates = [item.strip().split()[0] for item in value.split(",") if item.strip()]
    return candidates[-1] if candidates else ""


def content_container_rank(tag: str, attrs: list[tuple[str, str | None]]) -> int:
    selector = " ".join(
        value.lower() for key, value in attrs if key.lower() in {"class", "id"} and value
    )
    if any(marker in selector for marker in PRIMARY_CONTENT_MARKERS):
        return 2
    if tag == "article" or "article-content" in selector:
        return 1
    return 0


class ReadablePageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.headings: list[dict[str, str]] = []
        self.images: list[dict[str, str]] = []
        self.base_href = ""
        self.in_title = False
        self.heading_tag: str | None = None
        self.heading_parts: list[str] = []
        self.skip_depth = 0
        self.content_stack: list[int] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self.skip_depth:
            if tag not in VOID_TAGS:
                self.skip_depth += 1
            return
        if tag in BLOCKED_TAGS or has_ad_marker(attrs):
            if tag not in VOID_TAGS:
                self.skip_depth = 1
            return
        attr_map = {key.lower(): value or "" for key, value in attrs}
        content_rank = self.content_stack[-1] if self.content_stack else 0
        if tag not in VOID_TAGS:
            content_rank = max(content_rank, content_container_rank(tag, attrs))
            self.content_stack.append(content_rank)
        if tag == "base" and attr_map.get("href") and not self.base_href:
            self.base_href = attr_map["href"]
        if tag == "img":
            source = next((attr_map[name].strip() for name in IMAGE_SOURCE_ATTRIBUTES if attr_map.get(name, "").strip()), "")
            if not source and attr_map.get("srcset"):
                source = source_from_srcset(attr_map["srcset"])
            if source and not source.lower().startswith(("data:", "blob:", "javascript:")):
                self.images.append({
                    "source": source,
                    "alt": normalize_inline(attr_map.get("alt", "")),
                    "title": normalize_inline(attr_map.get("title", "")),
                    "scope": "article" if content_rank >= 2 else "content" if content_rank == 1 else "page",
                })
        if tag == "title":
            self.in_title = True
        if tag in {"h1", "h2", "h3"}:
            self.heading_tag = tag
            self.heading_parts = []
        if tag in BLOCK_TAGS or tag == "br":
            self.text_parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        stack_size = len(self.content_stack)
        self.handle_starttag(tag, attrs)
        if len(self.content_stack) > stack_size:
            self.content_stack.pop()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.skip_depth:
            self.skip_depth -= 1
            return
        if tag == "title":
            self.in_title = False
        if self.heading_tag == tag:
            heading = normalize_inline("".join(self.heading_parts))
            if heading:
                self.headings.append({"level": tag, "text": heading})
            self.heading_tag = None
            self.heading_parts = []
        if tag in BLOCK_TAGS:
            self.text_parts.append("\n")
        if tag not in VOID_TAGS and self.content_stack:
            self.content_stack.pop()

    def handle_data(self, data: str) -> None:
        if self.skip_depth or not data.strip():
            return
        if self.in_title:
            self.title_parts.append(data)
        if self.heading_tag:
            self.heading_parts.append(data)
        self.text_parts.extend((data, " "))

    @property
    def title(self) -> str:
        return normalize_inline("".join(self.title_parts)) or "未命名页面"

    @property
    def text(self) -> str:
        lines: list[str] = []
        for raw_line in "".join(self.text_parts).splitlines():
            line = normalize_inline(raw_line)
            if line and (not lines or line != lines[-1]):
                lines.append(line)
        return "\n\n".join(lines)


def normalize_inline(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def safe_filename(value: str) -> str:
    value = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", value, flags=re.UNICODE).strip("-_")
    return value[:60] or "page"


def image_filename(index: int, image_url: str, alt: str, content_type: str) -> str:
    url_stem = Path(parse.unquote(parse.urlsplit(image_url).path)).stem
    stem = safe_filename(alt or url_stem or "image")[:40]
    return f"{index:03d}-{stem}{IMAGE_EXTENSIONS[content_type]}"


def download_images(
    image_candidates: list[dict[str, str]], page_url: str, page_directory: Path,
    allow_private: bool, max_images: int, max_image_bytes: int,
) -> list[dict[str, object]]:
    image_directory = page_directory / "images"
    results: list[dict[str, object]] = []
    seen: set[str] = set()
    total_bytes = 0
    scope_order = {"article": 0, "content": 1, "page": 2}
    ordered_candidates = sorted(
        enumerate(image_candidates),
        key=lambda item: (scope_order.get(item[1].get("scope", "page"), 2), item[0]),
    )
    for _, candidate in ordered_candidates:
        absolute_url = parse.urldefrag(parse.urljoin(page_url, candidate["source"])).url
        if absolute_url in seen:
            continue
        seen.add(absolute_url)
        if len(results) >= max_images:
            break
        record: dict[str, object] = {
            "source_url": absolute_url, "alt": candidate["alt"],
            "title": candidate["title"], "scope": candidate.get("scope", "page"),
            "status": "failed",
        }
        try:
            normalized_url(absolute_url)
            ensure_safe_host(absolute_url, allow_private)
            image_request = request.Request(
                absolute_url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                    "Referer": page_url,
                },
            )
            with build_opener(allow_private).open(image_request, timeout=TIMEOUT_SECONDS) as response:
                final_url = response.geturl()
                ensure_safe_host(final_url, allow_private)
                content_type = response.headers.get_content_type().lower()
                if content_type not in IMAGE_EXTENSIONS:
                    raise ValueError(f"响应不是支持的图片类型：{content_type}")
                raw = response.read(max_image_bytes + 1)
                if len(raw) > max_image_bytes:
                    raise ValueError(f"图片超过 {max_image_bytes // (1024 * 1024)} MB 上限")
                if total_bytes + len(raw) > MAX_TOTAL_IMAGE_BYTES:
                    raise ValueError("本页图片累计超过 100 MB 上限")
                image_directory.mkdir(parents=True, exist_ok=True)
                filename = image_filename(len(results) + 1, final_url, candidate["alt"], content_type)
                image_path = image_directory / filename
                image_path.write_bytes(raw)
                total_bytes += len(raw)
                record.update({
                    "status": "saved", "final_url": final_url, "content_type": content_type,
                    "bytes": len(raw), "local_path": image_path.relative_to(page_directory).as_posix(),
                })
        except (ValueError, error.URLError, TimeoutError, OSError) as exc:
            record["error"] = str(exc)
        results.append(record)
    return results


def save_page(
    source_url: str, final_url: str, parser: ReadablePageParser, output: Path,
    allow_private: bool, download_page_images: bool, max_images: int, max_image_bytes: int,
) -> tuple[Path, Path, Path, Path, list[dict[str, object]]]:
    output.mkdir(parents=True, exist_ok=True)
    timestamp = dt.datetime.now(dt.timezone.utc)
    basename = f"{timestamp.strftime('%Y%m%d-%H%M%S-%f')}-{safe_filename(parser.title)}"
    page_directory = output / basename
    page_directory.mkdir()
    image_base_url = parse.urljoin(final_url, parser.base_href) if parser.base_href else final_url
    images = download_images(
        parser.images, image_base_url, page_directory, allow_private, max_images, max_image_bytes,
    ) if download_page_images else []
    text_path = page_directory / "content.txt"
    markdown_path = page_directory / "content.md"
    json_path = page_directory / "content.json"
    notice = "保存了清洗后的页面文字和可下载图片；未执行脚本、表单、音频或视频。"
    text_path.write_text(
        f"标题：{parser.title}\n来源：{final_url}\n抓取时间：{timestamp.isoformat()}\n说明：{notice}\n\n{parser.text}\n",
        encoding="utf-8",
    )
    saved_images = [item for item in images if item["status"] == "saved"]
    markdown_images = "\n\n".join(
        f"![{item['alt'] or '页面图片'}]({item['local_path']})" for item in saved_images
    )
    markdown_path.write_text(
        f"# {parser.title}\n\n来源：<{final_url}>\n\n{parser.text}"
        + (f"\n\n## 页面图片\n\n{markdown_images}" if markdown_images else "") + "\n",
        encoding="utf-8",
    )
    json_path.write_text(
        json.dumps({
            "source_url": source_url, "final_url": final_url,
            "fetched_at": timestamp.isoformat(), "title": parser.title,
            "headings": parser.headings, "text": parser.text, "images": images,
            "image_summary": {
                "discovered": len(parser.images), "attempted": len(images),
                "saved": len(saved_images), "failed": len(images) - len(saved_images),
            },
            "notice": notice,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return page_directory, text_path, markdown_path, json_path, images


def main() -> int:
    args = parse_args()
    raw_url = args.url or input("请输入要保存的页面网址：").strip()
    try:
        url = normalized_url(raw_url)
        html, final_url = fetch_html(url, args.allow_private)
        parser = ReadablePageParser()
        parser.feed(html)
        parser.close()
        if not parser.text:
            raise ValueError("页面没有可保存的文字内容。")
        page_directory, text_path, markdown_path, json_path, images = save_page(
            url, final_url, parser, Path(args.output).expanduser(), args.allow_private,
            not args.no_images, args.max_images, args.max_image_mb * 1024 * 1024,
        )
    except (ValueError, PermissionError, error.URLError, TimeoutError, OSError) as exc:
        print(f"抓取失败：{exc}", file=sys.stderr)
        return 1

    saved_count = sum(item["status"] == "saved" for item in images)
    print("抓取完成：")
    print(f"- 页面目录：{page_directory.resolve()}")
    print(f"- 纯文本：{text_path.resolve()}")
    print(f"- Markdown：{markdown_path.resolve()}")
    print(f"- 结构化数据：{json_path.resolve()}")
    print(f"- 图片：成功 {saved_count} 张，失败 {len(images) - saved_count} 张")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
