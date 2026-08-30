#!/usr/bin/env python3
"""Save the readable text and structure of one authorized web page."""

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


USER_AGENT = "ShenxiangAuthorizedPageSaver/1.0"
MAX_BYTES = 5 * 1024 * 1024
TIMEOUT_SECONDS = 15
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
BLOCKED_TAGS = {"script", "style", "noscript", "iframe", "video", "audio", "canvas", "form", "dialog", "template"}
BLOCK_TAGS = {"article", "aside", "blockquote", "div", "footer", "h1", "h2", "h3", "h4", "header", "li", "main", "nav", "p", "section", "table", "tr"}
AD_MARKERS = {
    "ad",
    "ads",
    "advert",
    "advertisement",
    "affiliate",
    "casino",
    "commercial",
    "modal",
    "popup",
    "promo",
    "promotion",
    "sponsor",
    "sponsored",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="抓取一个已获授权页面，过滤常见广告后保存标题、章节和纯文本正文。"
    )
    parser.add_argument("url", nargs="?", help="要保存的 http(s) 页面网址；省略时会交互询问")
    parser.add_argument("--output", default="scraped-pages", help="保存目录，默认 scraped-pages")
    parser.add_argument(
        "--allow-private",
        action="store_true",
        help="允许 localhost 或内网地址，仅用于你控制的本地开发环境",
    )
    return parser.parse_args()


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
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
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
        raise PermissionError("robots.txt 不允许此抓取工具访问该页面。")

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
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("页面超过 5 MB 安全上限，已停止保存。")
        charset = response.headers.get_content_charset() or "utf-8"
        try:
            html = raw.decode(charset, errors="replace")
        except LookupError:
            html = raw.decode("utf-8", errors="replace")
        return html, final_url


def has_ad_marker(attrs: list[tuple[str, str | None]]) -> bool:
    values: list[str] = []
    for key, value in attrs:
        if key.lower() in {"class", "id", "role", "aria-label", "data-ad", "data-ad-slot"} and value:
            values.append(value.lower())
    tokens = set(re.split(r"[^a-z0-9\u4e00-\u9fff]+", " ".join(values)))
    return bool(tokens & AD_MARKERS)


class ReadablePageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.headings: list[dict[str, str]] = []
        self.in_title = False
        self.heading_tag: str | None = None
        self.heading_parts: list[str] = []
        self.skip_depth = 0

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
        if tag == "title":
            self.in_title = True
        if tag in {"h1", "h2", "h3"}:
            self.heading_tag = tag
            self.heading_parts = []
        if tag in BLOCK_TAGS or tag == "br":
            self.text_parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if not self.skip_depth and tag.lower() == "br":
            self.text_parts.append("\n")

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

    def handle_data(self, data: str) -> None:
        if self.skip_depth or not data.strip():
            return
        if self.in_title:
            self.title_parts.append(data)
        if self.heading_tag:
            self.heading_parts.append(data)
        self.text_parts.append(data)
        self.text_parts.append(" ")

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


def save_page(url: str, final_url: str, parser: ReadablePageParser, output: Path) -> tuple[Path, Path]:
    output.mkdir(parents=True, exist_ok=True)
    timestamp = dt.datetime.now(dt.timezone.utc)
    basename = f"{timestamp.strftime('%Y%m%d-%H%M%S')}-{safe_filename(parser.title)}"
    text_path = output / f"{basename}.txt"
    json_path = output / f"{basename}.json"
    notice = "仅保存页面文字；未下载图片、视频、脚本、表单或广告素材。"
    text_path.write_text(
        f"标题：{parser.title}\n来源：{final_url}\n抓取时间：{timestamp.isoformat()}\n说明：{notice}\n\n{parser.text}\n",
        encoding="utf-8",
    )
    json_path.write_text(
        json.dumps(
            {
                "source_url": url,
                "final_url": final_url,
                "fetched_at": timestamp.isoformat(),
                "title": parser.title,
                "headings": parser.headings,
                "text": parser.text,
                "notice": notice,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return text_path, json_path


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
        text_path, json_path = save_page(url, final_url, parser, Path(args.output).expanduser())
    except (ValueError, PermissionError, error.URLError, TimeoutError, OSError) as exc:
        print(f"抓取失败：{exc}", file=sys.stderr)
        return 1

    print("抓取完成：")
    print(f"- 纯文本：{text_path.resolve()}")
    print(f"- 结构化数据：{json_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
