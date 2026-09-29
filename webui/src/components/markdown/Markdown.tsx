import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { zh } from '../../i18n/zh';

/** 流式 Markdown（主 spec §3.2）。
 *  - 组件整体 memo：已完成块 props 稳定，不随流式重渲染（性能清单 §7.2 第 2 条）；
 *  - 未闭合语法交给 remark 优雅处理，不自行修补（不闪烁）；
 *  - 代码块流式期间纯文本，结束后再懒加载 Shiki 高亮（§7.2 第 6 条）。 */

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeRenderer,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function CodeRenderer({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }): React.ReactElement {
  const isBlock = /language-/.test(className ?? '');
  if (!isBlock) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }
  const lang = /language-(\S+)/.exec(className ?? '')?.[1] ?? '';
  const raw = String(children);
  return <CodeBlock code={raw.replace(/\n$/, '')} lang={lang} />;
}

/** 代码块：语言名 + 复制按钮（复制后图标变 ✓）。 */
export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    // 空闲时懒加载 Shiki；失败则保持纯文本（高亮是增强，不是依赖）
    const t = setTimeout(() => {
      void (async () => {
        try {
          const { createHighlighter } = await import('shiki');
          const highlighter = await createHighlighter({ themes: ['github-light'], langs: [lang || 'text'] });
          const out = highlighter.codeToHtml(code, { lang: lang || 'text', theme: 'github-light' });
          if (!cancelled) setHtml(out);
        } catch {
          /* 保持纯文本 */
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [code, lang]);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="codeblock">
      <span className="lang">
        <span>{lang}</span>
        <button className="copy" aria-label={zh.copy} data-copied={copied} onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </span>
      {html !== null ? (
        <div className="shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre ref={ref}>{code}</pre>
      )}
    </div>
  );
});
