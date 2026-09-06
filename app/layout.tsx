import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://news.osfeng.cn";

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(siteUrl),
    title: "深巷｜发现热点，关注身边事",
    description: "深巷，汇集新闻线索与热点动态，带你发现值得关注的身边事。",
    applicationName: "深巷",
    icons: {
      icon: [{ url: "/favicon.png", type: "image/png", sizes: "64x64" }],
      shortcut: "/favicon.png",
      apple: "/favicon.png",
    },
    openGraph: {
      title: "深巷｜发现热点，关注身边事",
      description: "深巷，汇集新闻线索与热点动态，带你发现值得关注的身边事。",
      type: "website",
      url: "/",
      siteName: "深巷",
      locale: "zh_CN",
      images: [{ url: "/api/share/cover", width: 480, height: 480, type: "image/jpeg", alt: "深巷｜城市观察与同城报道" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "深巷｜发现热点，关注身边事",
      description: "深巷，汇集新闻线索与热点动态，带你发现值得关注的身边事。",
      images: ["/api/share/cover"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
