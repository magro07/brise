import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, CodeXml } from "lucide-react";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

const LANG_NAME: Record<string, string> = { js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX", py: "Python", python: "Python", rs: "Rust", rust: "Rust", sh: "Shell", bash: "Shell", json: "JSON", html: "HTML", css: "CSS", lua: "Lua", luau: "Luau", toml: "TOML", yaml: "YAML", md: "Markdown" };

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  return (
    <div className="my-3 overflow-hidden rounded-2xl bg-code">
      <div className="flex h-9 items-center gap-2 px-4 text-[0.88em] text-fg-2">
        <CodeXml className="h-4 w-4" />
        <span className="flex-1">{LANG_NAME[lang ?? ""] ?? lang ?? "Code"}</span>
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
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
