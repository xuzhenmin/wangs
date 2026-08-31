import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3217";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    title: "深巷｜三千万风波完整吃瓜时间线",
    description: "从神秘富豪传闻、万字长文到财产诉讼，一次梳理整场风波。",
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: {
      title: "深巷｜三千万风波完整吃瓜时间线",
      description: "保留八卦脉络，过滤广告与来源不明的私密材料。",
      type: "website",
      images: [{ url: `${origin}/editorial-dispute-v1.png`, width: 1536, height: 1024, alt: "财产争议司法程序新闻示意图" }],
    },
    twitter: { card: "summary_large_image", title: "深巷｜三千万风波完整吃瓜时间线", description: "保留八卦脉络，过滤广告与来源不明的私密材料。", images: [`${origin}/editorial-dispute-v1.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
