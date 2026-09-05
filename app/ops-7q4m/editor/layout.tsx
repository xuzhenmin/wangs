import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "文档编辑与录入｜深巷后台",
  description: "新增、编辑和实时预览深巷站点内容。",
  robots: { index: false, follow: false },
  openGraph: {
    title: "文档编辑与录入｜深巷后台",
    description: "新增、编辑和实时预览深巷站点内容。",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "文档编辑与录入｜深巷后台",
    description: "新增、编辑和实时预览深巷站点内容。",
  },
};

export default function ContentEditorLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
