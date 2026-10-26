import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "lucide-react";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  return (
    <div className="group/code relative my-3">
      <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover/code:opacity-100">
        {lang && <span className="rounded bg-elev px-1.5 text-[11px] text-muted">{lang}</span>}
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md border border-line bg-elev text-muted hover:text-fg"
          onClick={() => {
            navigator.clipboard.writeText(textOf(children));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          aria-label="Code kopieren"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <pre className="!my-0">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat selectable">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            const props = (child as { props?: { className?: string; children?: ReactNode } })?.props ?? {};
            return <CodeBlock className={props.className}>{props.children}</CodeBlock>;
          },
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) openUrl(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
