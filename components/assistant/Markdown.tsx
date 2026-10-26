"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders assistant answers as formatted GitHub-flavored markdown (bold, lists,
 * tables, code), styled to the slate/sky shell. Component overrides carry all the
 * styling, so we don't need the Tailwind typography plugin. The model already returns
 * markdown; this renders it instead of printing it as raw text.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: (p) => <p className="mb-2 last:mb-0" {...p} />,
        strong: (p) => <strong className="font-semibold text-gray-900" {...p} />,
        em: (p) => <em className="italic" {...p} />,
        ul: (p) => <ul className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0" {...p} />,
        ol: (p) => <ol className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0" {...p} />,
        li: (p) => <li className="marker:text-gray-400" {...p} />,
        h1: (p) => <h4 className="mb-1 mt-1 text-sm font-semibold text-gray-900" {...p} />,
        h2: (p) => <h4 className="mb-1 mt-1 text-sm font-semibold text-gray-900" {...p} />,
        h3: (p) => <h4 className="mb-1 mt-1 text-sm font-semibold text-gray-900" {...p} />,
        a: (p) => <a className="text-sky-700 underline" target="_blank" rel="noreferrer" {...p} />,
        code: (p) => (
          <code
            className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-slate-800"
            {...p}
          />
        ),
        pre: (p) => (
          <pre
            className="mb-2 overflow-x-auto rounded bg-slate-900 p-2 text-[12px] text-sky-200 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-sky-200"
            {...p}
          />
        ),
        table: (p) => (
          <div className="mb-2 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs" {...p} />
          </div>
        ),
        th: (p) => (
          <th className="border-b border-gray-200 px-2 py-1 font-medium text-gray-500" {...p} />
        ),
        td: (p) => <td className="border-b border-gray-100 px-2 py-1 text-gray-700" {...p} />,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
