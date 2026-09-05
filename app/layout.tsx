import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://news.osfeng.cn";

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(siteUrl),
    title: "景甜张继科地下恋：红娘事件及时间线全曝光｜深巷",
    description: "娱乐圈女演员景甜、张继科地下恋红娘事件及时间线全曝光，任嘉伦被指是真正牵线人。",
    applicationName: "深巷",
    icons: {
      icon: [{ url: "/favicon.png", type: "image/png", sizes: "64x64" }],
      shortcut: "/favicon.png",
      apple: "/favicon.png",
    },
    openGraph: {
      title: "景甜张继科地下恋：红娘事件及时间线全曝光｜深巷",
      description: "景甜、张继科地下恋时间线及任嘉伦牵线人传闻梳理。",
      type: "website",
      url: "/",
      siteName: "深巷",
      locale: "zh_CN",
      images: [{ url: "/og.png", width: 1731, height: 909, alt: "深巷｜城市观察与同城报道" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "景甜张继科地下恋：红娘事件及时间线全曝光｜深巷",
      description: "景甜、张继科地下恋时间线及任嘉伦牵线人传闻梳理。",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
