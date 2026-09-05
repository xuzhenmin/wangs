"use client";

import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import Placeholder from "@tiptap/extension-placeholder";

function editorExtensions(withPlaceholder = false) {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
    }),
    Image.configure({ inline: false, allowBase64: false }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    ...(withPlaceholder ? [Placeholder.configure({ placeholder: "在这里输入正文内容……" })] : []),
  ];
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeLegacyContent(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return "<p></p>";
  if (trimmed.startsWith("<")) return trimmed;
  return trimmed.split("\n").map((line) => {
    const text = line.trim();
    if (!text) return "<p></p>";
    if (text.startsWith("### ")) return `<h3>${escapeHtml(text.slice(4))}</h3>`;
    if (text.startsWith("## ")) return `<h2>${escapeHtml(text.slice(3))}</h2>`;
    if (text.startsWith("# ")) return `<h1>${escapeHtml(text.slice(2))}</h1>`;
    if (text.startsWith("> ")) return `<blockquote><p>${escapeHtml(text.slice(2))}</p></blockquote>`;
    if (text.startsWith("- ")) return `<ul><li><p>${escapeHtml(text.slice(2))}</p></li></ul>`;
    return `<p>${escapeHtml(text)}</p>`;
  }).join("");
}

function ToolbarButton({
  label,
  title,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return <button type="button" className={active ? "active" : ""} disabled={disabled} onClick={onClick} title={title} aria-label={title}>{label}</button>;
}

export function RichTextEditor({ content, onChange }: { content: string; onChange: (content: string) => void }) {
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    extensions: editorExtensions(true),
    content: normalizeLegacyContent(content),
    editorProps: { attributes: { class: "rich-text-surface" } },
    onUpdate: ({ editor: currentEditor }) => onChange(currentEditor.getHTML()),
  });

  useEffect(() => {
    if (!editor) return;
    const normalized = normalizeLegacyContent(content);
    if (editor.getHTML() !== normalized) editor.commands.setContent(normalized, { emitUpdate: false });
  }, [content, editor]);

  if (!editor) return <div className="rich-editor-loading">正在加载富文本编辑器…</div>;

  const setLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const value = window.prompt("输入链接地址；留空可移除当前链接", previous || "https://");
    if (value === null) return;
    const href = value.trim();
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const normalized = /^(https?:\/\/|mailto:|\/)/i.test(href) ? href : `https://${href}`;
    editor.chain().focus().extendMarkRange("link").setLink({ href: normalized }).run();
  };

  const insertImage = () => {
    const value = window.prompt("输入图片的 HTTPS 地址");
    if (!value) return;
    const src = value.trim();
    if (!/^https?:\/\//i.test(src)) {
      window.alert("请输入以 http:// 或 https:// 开头的图片地址。");
      return;
    }
    const alt = window.prompt("输入图片说明（可选）")?.trim() || "";
    editor.chain().focus().setImage({ src, alt }).run();
  };

  return (
    <div className="rich-editor">
      <div className="rich-toolbar" role="toolbar" aria-label="富文本格式工具栏">
        <div className="toolbar-group">
          <ToolbarButton label="正文" title="正文" active={editor.isActive("paragraph")} onClick={() => editor.chain().focus().setParagraph().run()} />
          <ToolbarButton label="H1" title="一级标题" active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
          <ToolbarButton label="H2" title="二级标题" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
          <ToolbarButton label="H3" title="三级标题" active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
        </div>
        <div className="toolbar-group">
          <ToolbarButton label="B" title="加粗" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} />
          <ToolbarButton label="I" title="斜体" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} />
          <ToolbarButton label="U" title="下划线" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} />
          <ToolbarButton label="S" title="删除线" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()} />
          <ToolbarButton label="‹/›" title="行内代码" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()} />
        </div>
        <div className="toolbar-group">
          <ToolbarButton label="• 列表" title="无序列表" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} />
          <ToolbarButton label="1. 列表" title="有序列表" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
          <ToolbarButton label="❝" title="引用" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
          <ToolbarButton label="—" title="分隔线" onClick={() => editor.chain().focus().setHorizontalRule().run()} />
        </div>
        <div className="toolbar-group">
          <ToolbarButton label="左" title="左对齐" active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()} />
          <ToolbarButton label="中" title="居中对齐" active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()} />
          <ToolbarButton label="右" title="右对齐" active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()} />
        </div>
        <div className="toolbar-group">
          <ToolbarButton label="链接" title="添加或修改链接" active={editor.isActive("link")} onClick={setLink} />
          <ToolbarButton label="图片" title="通过图片地址插入图片" onClick={insertImage} />
        </div>
        <div className="toolbar-group">
          <ToolbarButton label="↶" title="撤销" disabled={!editor.can().chain().focus().undo().run()} onClick={() => editor.chain().focus().undo().run()} />
          <ToolbarButton label="↷" title="重做" disabled={!editor.can().chain().focus().redo().run()} onClick={() => editor.chain().focus().redo().run()} />
          <ToolbarButton label="清除格式" title="清除所选文字格式" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} />
        </div>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

export function RichTextPreview({ content }: { content: string }) {
  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: editorExtensions(),
    content: normalizeLegacyContent(content),
    editorProps: { attributes: { class: "rich-text-preview-surface" } },
  });

  useEffect(() => {
    if (!editor) return;
    const normalized = normalizeLegacyContent(content);
    if (editor.getHTML() !== normalized) editor.commands.setContent(normalized, { emitUpdate: false });
  }, [content, editor]);

  return <EditorContent editor={editor} />;
}
