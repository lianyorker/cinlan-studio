import assert from 'node:assert/strict'
import { providerTaskId, resultUrls } from '../lib/server/generation'
import { parseEventStream, Sub2ApiError } from '../lib/server/sub2api'
import { GPT_IMAGE_PROVIDER_SAFE_SIZE, isGptImageSizeValidationError, shouldFallbackToSynchronousImageEndpoint } from '../lib/server/creative/provider'

const png = 'iVBORw0KGgo' + 'A'.repeat(40)

assert.equal(providerTaskId({ data: { taskId: 'nested-task' } }), 'nested-task')
assert.equal(providerTaskId({ id: 'top-level-task' }), 'top-level-task')
assert.deepEqual(resultUrls({ output: { images: [{ url: 'https://media.example/image.png' }] } }), ['https://media.example/image.png'])
assert.deepEqual(resultUrls({ result: { artifacts: [{ content_type: 'image/jpeg', b64_json: png }] } }), [`data:image/jpeg;base64,${png}`])
assert.deepEqual(resultUrls({ output: { id: 'A'.repeat(80), status: 'processing' } }), [])
assert.deepEqual(resultUrls({ output: [{ type: 'image_generation_call', result: png }] }), [`data:image/png;base64,${png}`])
assert.deepEqual(resultUrls({ image: { url: { value: 'https://media.example/object-url.png' } } }), ['https://media.example/object-url.png'])

const merged = parseEventStream(`event: image.created\ndata: ${JSON.stringify({ task_id: 'sse-task' })}\n\nevent: image.completed\ndata: ${JSON.stringify({ images: [{ url: 'https://media.example/sse.png' }] })}\n\n`)
assert.equal(providerTaskId(merged), 'sse-task')
assert.deepEqual(resultUrls(merged), ['https://media.example/sse.png'])
assert.equal(providerTaskId({ message: 'provider failed' }), '')
assert.deepEqual(resultUrls({ status: 'completed', data: [] }), [])
assert.equal(isGptImageSizeValidationError(new Sub2ApiError(400, 'size must be a WIDTHxHEIGHT string')), true)
assert.equal(isGptImageSizeValidationError(new Sub2ApiError(400, '$width must be one of: 768, 832, 1024')), true)
assert.equal(isGptImageSizeValidationError(new Sub2ApiError(400, 'invalid prompt')), false)
assert.equal(GPT_IMAGE_PROVIDER_SAFE_SIZE, '1024x1024')
assert.equal(shouldFallbackToSynchronousImageEndpoint(new Sub2ApiError(400, 'async image tasks are not enabled', 'not_found_error')), true)
assert.equal(shouldFallbackToSynchronousImageEndpoint(new Sub2ApiError(400, 'async image tasks are disabled', 'not_found_error')), true)
assert.equal(shouldFallbackToSynchronousImageEndpoint(new Sub2ApiError(502, 'insufficient tokens', 'UPSTREAM_HTTP_502')), false)

console.log('Provider response test passed')
