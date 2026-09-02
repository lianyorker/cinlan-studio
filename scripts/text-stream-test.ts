import assert from 'node:assert/strict'
import { appendTextDelta, errorMessageFromPayload, parseJsonData, takeSseFrames, textDeltaFromPayload } from '../lib/text-stream'

const first = takeSseFrames('data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\npartial')
assert.equal(first.frames.length, 1)
assert.equal(first.remainder, 'partial')
assert.equal(textDeltaFromPayload(parseJsonData(first.frames[0].data)), '你好')

const final = takeSseFrames('data: {\"choices\":[{\"message\":{\"content\":\"你好，世界\"}}]}\n\ndata: [DONE]\n\n', true)
assert.equal(final.frames.length, 2)
assert.equal(textDeltaFromPayload(parseJsonData(final.frames[0].data)), '你好，世界')

let text = ''
for (const chunk of ['你', '好，', '世界']) text = appendTextDelta(text, chunk)
assert.equal(text, '你好，世界')
assert.equal(appendTextDelta(text, '你好，世界'), text)
assert.equal(appendTextDelta(text, '你好，世界！'), '你好，世界！')
assert.equal(appendTextDelta('hello', 'lo'), 'hellolo')
const splitCr = takeSseFrames('data: {\"text\":\"a\"}\r')
assert.equal(splitCr.frames.length, 0)
assert.equal(splitCr.remainder.endsWith('\r'), true)
const crlf = takeSseFrames(splitCr.remainder + '\n\n', false)
assert.equal(crlf.frames.length, 1)
assert.equal(crlf.frames[0].data.includes('a'), true)
assert.equal(takeSseFrames('data:  leading\n\n', true).frames[0].data, ' leading')
assert.equal(textDeltaFromPayload({ data: { choices: [{ message: { content: 'nested answer' } }] } }), 'nested answer')
assert.equal(errorMessageFromPayload({ data: { error: 'nested failure' } }), 'nested failure')
assert.equal(errorMessageFromPayload({ error: { message: 'upstream failed' } }), 'upstream failed')

console.log('Text stream test passed')