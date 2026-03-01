import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import DOMPurify from "dompurify";
import { Info, Lightbulb, AlertTriangle, AlertOctagon } from "lucide-react";
import { cn } from "../../../design-tokens";

type HfReadmeRendererProps = {
  content: string;
  className?: string;
};

type AdmonitionType = "Note" | "Tip" | "Important" | "Warning" | "Caution";

const ADMONITION_CONFIG: Record<
  AdmonitionType,
  { icon: typeof Info; border: string; bg: string; iconColor: string; title: string }
> = {
  Note: {
    icon: Info,
    border: "border-blue-400/40",
    bg: "bg-blue-500/10",
    iconColor: "text-blue-400",
    title: "text-blue-300",
  },
  Tip: {
    icon: Lightbulb,
    border: "border-emerald-400/40",
    bg: "bg-emerald-500/10",
    iconColor: "text-emerald-400",
    title: "text-emerald-300",
  },
  Important: {
    icon: AlertTriangle,
    border: "border-violet-400/40",
    bg: "bg-violet-500/10",
    iconColor: "text-violet-400",
    title: "text-violet-300",
  },
  Warning: {
    icon: AlertTriangle,
    border: "border-amber-400/40",
    bg: "bg-amber-500/10",
    iconColor: "text-amber-400",
    title: "text-amber-300",
  },
  Caution: {
    icon: AlertOctagon,
    border: "border-red-400/40",
    bg: "bg-red-500/10",
    iconColor: "text-red-400",
    title: "text-red-300",
  },
};

const ADMONITION_TYPES = new Set<string>(["Note", "Tip", "Important", "Warning", "Caution"]);

const ADMONITION_RE = /^>\s*\[!(Note|Tip|Important|Warning|Caution)\]\s*$/i;

function preprocessAdmonitions(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const match = ADMONITION_RE.exec(lines[i]);
    if (match) {
      const type = match[1];
      const key = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<div data-admonition="${key}">`);
      out.push("");
      out.push(body.join("\n"));
      out.push("");
      out.push("</div>");
    } else {
      out.push(lines[i]);
      i++;
    }
  }

  return out.join("\n");
}

DOMPurify.addHook("uponSanitizeElement", (node, data) => {
  if (data.tagName === "div" && (node as Element).getAttribute?.("data-admonition")) {
    return;
  }
});

function sanitize(raw: string): string {
  return DOMPurify.sanitize(raw, {
    ADD_TAGS: ["iframe"],
    ADD_ATTR: [
      "target",
      "data-admonition",
      "colspan",
      "rowspan",
      "style",
      "width",
      "height",
      "loading",
    ],
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ["script", "style"],
  });
}


function Admonition({ type, children }: { type: AdmonitionType; children: React.ReactNode }) {
  const cfg = ADMONITION_CONFIG[type] ?? ADMONITION_CONFIG.Note;
  const Icon = cfg.icon;

  return (
    <div className={cn("my-3 rounded-xl border-l-4 px-4 py-3", cfg.border, cfg.bg)}>
      <div className={cn("mb-2 flex items-center gap-2 text-xs font-semibold", cfg.title)}>
        <Icon size={14} className={cfg.iconColor} />
        {type}
      </div>
      <div className="space-y-2 text-sm leading-relaxed text-fg/75">{children}</div>
    </div>
  );
}

export function HfReadmeRenderer({ content, className = "" }: HfReadmeRendererProps) {
  const processed = useMemo(() => {
    const withAdmonitions = preprocessAdmonitions(content);
    return sanitize(withAdmonitions);
  }, [content]);

  return (
    <div className={cn("hf-readme", className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          h1: ({ children }) => <h1 className="mt-6 mb-3 text-xl font-bold text-fg">{children}</h1>,
          h2: ({ children }) => (
            <h2 className="mt-5 mb-2.5 text-lg font-bold text-fg">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 mb-2 text-base font-semibold text-fg">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-3 mb-1.5 text-sm font-semibold text-fg/90">{children}</h4>
          ),
          h5: ({ children }) => (
            <h5 className="mt-2 mb-1 text-sm font-medium text-fg/80">{children}</h5>
          ),
          h6: ({ children }) => (
            <h6 className="mt-2 mb-1 text-xs font-medium text-fg/70">{children}</h6>
          ),

          p: ({ children, node }) => {
            const childArr = Array.isArray(children) ? children : [children];
            if (
              childArr.length === 1 &&
              typeof childArr[0] === "object" &&
              childArr[0] !== null &&
              "type" in childArr[0] &&
              childArr[0].type === "img"
            ) {
              return <>{children}</>;
            }

            const parent = (node as any)?.parent ?? (node as any)?.parentNode;
            const parentProps = parent?.properties ?? parent?.attrs;
            if (parent?.tagName === "div" && parentProps?.dataAdmonition) {
              return <p className="whitespace-pre-wrap wrap-break-word">{children}</p>;
            }

            return (
              <p className="my-2 whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-fg/80">
                {children}
              </p>
            );
          },

          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline underline-offset-2 hover:text-accent/80"
            >
              {children}
            </a>
          ),

          img: ({ src, alt, width }) => {
            if (!src) return null;

            const isBadge =
              src.includes("img.shields.io") || src.includes("badge") || src.includes("badgen.net");

            if (isBadge) {
              return (
                <img
                  src={src}
                  alt={alt ?? ""}
                  className="inline-block h-5 rounded"
                  loading="lazy"
                />
              );
            }

            const style: React.CSSProperties = {};
            if (width) {
              const num = parseInt(String(width).replace("px", ""), 10);
              if (!isNaN(num)) style.maxWidth = num;
            }

            return (
              <figure className="my-3">
                <img
                  src={src}
                  alt={alt ?? ""}
                  className="max-w-full rounded-xl"
                  style={style}
                  loading="lazy"
                />
                {alt && (
                  <figcaption className="mt-1.5 text-center text-[11px] text-fg/40">
                    {alt}
                  </figcaption>
                )}
              </figure>
            );
          },

          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-xl border border-fg/10 bg-black/50 p-4 text-xs leading-relaxed text-fg/80">
              {children}
            </pre>
          ),
          code: ({ children, className: codeClassName }) => {
            if (codeClassName) {
              return <code className={codeClassName}>{children}</code>;
            }
            return (
              <code className="rounded bg-fg/10 px-1.5 py-0.5 text-[0.85em] text-accent/90">
                {children}
              </code>
            );
          },

          ul: ({ children }) => (
            <ul className="my-2 ml-5 list-disc space-y-1 text-sm text-fg/80">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 ml-5 list-decimal space-y-1 text-sm text-fg/80">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,

          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-fg/20 pl-4 text-sm italic text-fg/60">
              {children}
            </blockquote>
          ),

          table: ({ children }) => (
            <div className="hf-html-block my-3 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead>{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-fg/6">{children}</tr>,
          th: ({ children }) => (
            <th className="border-b-2 border-accent/30 px-2 py-2 text-left text-[11px] font-semibold text-fg/70 whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-2 py-1.5 text-center text-fg/70 tabular-nums border-b border-fg/6">
              {children}
            </td>
          ),

          hr: () => <hr className="my-6 border-t border-fg/10" />,

          strong: ({ children }) => (
            <strong className="font-semibold text-fg/90">{children}</strong>
          ),
          em: ({ children }) => <em className="opacity-80">{children}</em>,

          details: ({ children }) => (
            <details className="my-2 rounded-xl border border-fg/10 bg-fg/[0.02] open:pb-3">
              {children}
            </details>
          ),
          summary: ({ children }) => (
            <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-fg/80 hover:bg-fg/5 transition">
              {children}
            </summary>
          ),

          div: ({ children, node, ...rest }) => {
            const admonitionAttr =
              (node as any)?.properties?.dataAdmonition ?? (rest as any)["data-admonition"];

            if (admonitionAttr && ADMONITION_TYPES.has(admonitionAttr)) {
              return <Admonition type={admonitionAttr as AdmonitionType}>{children}</Admonition>;
            }

            return (
              <div className="hf-html-block my-3 overflow-x-auto text-sm text-fg/80" {...rest}>
                {children}
              </div>
            );
          },
        }}
      >
        {processed}
      </Markdown>
    </div>
  );
}
