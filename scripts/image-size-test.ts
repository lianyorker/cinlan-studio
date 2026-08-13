import assert from 'node:assert/strict'
import { imageAspectRatioFromPrompt, imageSizeIntentFromPrompt, normalizeImageAspectRatio } from '../lib/image-aspect-ratio'
import { sizeForResolution } from '../lib/server/creative/provider'

const supported = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '21:9']

assert.equal(normalizeImageAspectRatio('16：9'), '16:9')
assert.equal(imageAspectRatioFromPrompt('制作 9:16 竖屏海报', supported), '9:16')
assert.equal(imageAspectRatioFromPrompt('1920x1080 电商 Banner', supported), '16:9')
assert.equal(imageAspectRatioFromPrompt('1080×1920 手机壁纸', supported), '9:16')
assert.equal(imageAspectRatioFromPrompt('横版活动海报', supported), '16:9')
assert.equal(imageAspectRatioFromPrompt('竖版角色设定图', supported), '9:16')
assert.equal(imageAspectRatioFromPrompt('没有指定尺寸的写实产品图', supported), undefined)

const banner = imageSizeIntentFromPrompt('尺寸调整 1600*440 电商租赁 Banner，尺寸长440宽1660', supported)
assert.deepEqual(banner, { width: 1600, height: 440, aspectRatio: '40:11', source: 'dimensions' })

const labeled = imageSizeIntentFromPrompt('尺寸长440宽1660，电商租赁横幅', supported)
assert.deepEqual(labeled, { width: 1660, height: 440, aspectRatio: '83:22', source: 'dimensions' })
assert.equal(sizeForResolution(banner!.aspectRatio, '1K', banner), '1600x440')
const portraitRatio = imageSizeIntentFromPrompt('制作 9:16 竖屏海报', supported)
assert.equal(portraitRatio?.source, 'named')
assert.equal(sizeForResolution(portraitRatio!.aspectRatio, '1K'), '576x1024')
assert.equal(sizeForResolution('9:16', '1K'), '576x1024')

console.log('Image size test passed')
