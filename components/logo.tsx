export function Logo({ size = 36 }: { size?: number }) {
  return (
    <div
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        data-testid="brand-logo"
        src="/brand/cinlan-mark.png"
        alt="Cinlan Studio"
        className="pointer-events-none h-full w-full object-contain"
      />
    </div>
  )
}
