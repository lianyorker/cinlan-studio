import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent } from '../components/markdown-content'

const markdown = [
  '# Primary heading',
  '',
  '## Secondary heading',
  '',
  '- First item',
  '- Second item',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| Alpha | 1 |',
  '',
  '```text',
  'plain code',
  '```',
].join('\n')

const html = renderToStaticMarkup(<MarkdownContent value={markdown} />)
for (const tag of ['<h1', '<h2', '<ul', '<table', '<pre']) assert.ok(html.includes(tag), `Expected rendered ${tag}`)
assert.ok(!html.includes('## Secondary heading'))

console.log('Markdown render test passed')
