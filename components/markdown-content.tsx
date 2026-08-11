'use client'

import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function externalLink(href: string | undefined) {
  return Boolean(href && /^https?:\/\//i.test(href))
}

export function MarkdownContent({ value, className = '' }: { value: string; className?: string }) {
  return (
    <div className={`min-w-0 break-words text-[15px] leading-7 text-neutral-800 dark:text-neutral-200 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          h1: ({ node: _node, ...props }) => <h1 className="mb-4 mt-7 text-2xl font-semibold leading-8 first:mt-0" {...props} />,
          h2: ({ node: _node, ...props }) => <h2 className="mb-3 mt-7 text-xl font-semibold leading-7 first:mt-0" {...props} />,
          h3: ({ node: _node, ...props }) => <h3 className="mb-2 mt-6 text-lg font-semibold leading-7 first:mt-0" {...props} />,
          h4: ({ node: _node, ...props }) => <h4 className="mb-2 mt-5 font-semibold first:mt-0" {...props} />,
          p: ({ node: _node, ...props }) => <p className="my-4 first:mt-0 last:mb-0" {...props} />,
          ul: ({ node: _node, ...props }) => <ul className="my-4 list-disc space-y-1 pl-6" {...props} />,
          ol: ({ node: _node, ...props }) => <ol className="my-4 list-decimal space-y-1 pl-6" {...props} />,
          li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
          blockquote: ({ node: _node, ...props }) => <blockquote className="my-5 border-l-2 border-neutral-300 pl-4 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300" {...props} />,
          hr: ({ node: _node, ...props }) => <hr className="my-7 border-neutral-200 dark:border-neutral-800" {...props} />,
          a: ({ node: _node, href, ...props }) => <a href={href} target={externalLink(href) ? '_blank' : undefined} rel={externalLink(href) ? 'noreferrer noopener' : undefined} className="font-medium text-blue-600 underline decoration-blue-300 underline-offset-4 hover:text-blue-700 dark:text-blue-400 dark:decoration-blue-700 dark:hover:text-blue-300" {...props} />,
          pre: ({ node: _node, ...props }) => <pre className="my-5 max-w-full overflow-x-auto rounded-md bg-neutral-950 p-4 text-[13px] leading-6 text-neutral-100" {...props} />,
          code: ({ node: _node, className: codeClassName, ...props }) => <code className={`${codeClassName ?? ''} rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[0.9em] dark:bg-neutral-800 [&:where(pre_*)]:bg-transparent [&:where(pre_*)]:p-0`} {...props} />,
          table: ({ node: _node, ...props }) => <div className="my-5 max-w-full overflow-x-auto"><table className="w-full border-collapse text-left text-sm" {...props} /></div>,
          thead: ({ node: _node, ...props }) => <thead className="bg-neutral-50 dark:bg-neutral-900" {...props} />,
          th: ({ node: _node, ...props }) => <th className="border border-neutral-200 px-3 py-2 font-semibold dark:border-neutral-800" {...props} />,
          td: ({ node: _node, ...props }) => <td className="border border-neutral-200 px-3 py-2 align-top dark:border-neutral-800" {...props} />,
          img: ({ node: _node, alt = '', ...props }) => <img alt={alt} loading="lazy" decoding="async" className="my-5 max-h-[70vh] max-w-full rounded-md object-contain" {...props} />,
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  )
}
