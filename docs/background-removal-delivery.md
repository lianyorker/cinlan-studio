# Transparent Asset Delivery

## Product semantics

Cinlan Studio separates two operations that must not be treated as equivalent:

1. **Checkerboard/simple-background removal** converts background pixels already drawn into an image into real PNG alpha while preserving the complete composition, including text, buttons, logos, shadows, and every foreground object.
2. **Complex-photo subject extraction** identifies a main subject and may intentionally discard copy, decorative elements, or secondary objects. This is an optional Alibaba Cloud `SegmentCommonImage` capability.

The “Transparent PNG” download path always attempts the layout-preserving operation first. A checkerboard asset does not require Alibaba Cloud credentials and does not consume the external daily quota.

## Layout-preserving flow

```text
source image
  -> decode in browser
  -> keep existing meaningful alpha when present
  -> inspect edge palette confidence
  -> remove edge-connected checkerboard/simple background
  -> verify transparent and opaque pixel coverage
  -> encode real PNG alpha
  -> reuse the processed result for preview and white-background export
```

The operation returns no successful transparent download when the output has no meaningful alpha. This prevents an opaque PNG from being mislabeled as a transparent result.

## Optional subject extraction

When a complex image cannot be handled as a simple connected background, the server may use Alibaba Cloud VIAPI `SegmentCommonImage` if credentials are configured.

- Input is normalized to JPEG, longest edge below 2000 pixels, and payload below 3 MB.
- The provider result is persisted as an Owner-isolated Creative Core asset.
- Jobs use the existing queue, event, cancellation, retry, and version flows.
- AccessKey values remain server-side and must never be returned to the browser or committed.
- Daily quota rules remain applicable only to provider-backed subject extraction.

`SegmentCommonImage` is not suitable for preserving a complete poster layout because it may classify text and decorative elements as background. It must not be the primary path for checkerboard assets.

## Acceptance criteria

- A checkerboard poster becomes a real alpha PNG and retains all visible design elements.
- Existing transparent PNG files remain transparent without a provider request.
- The transparent result replaces the modal preview and is reused for later transparent or white PNG downloads.
- An opaque result fails validation instead of downloading as “transparent”.
- Complex-photo subject extraction remains Owner-isolated and optional.
- No `.env`, AccessKey, provider response secret, or private asset is exposed in release artifacts.
