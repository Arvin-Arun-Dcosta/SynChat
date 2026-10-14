interface Props {
  name: string;
  src?: string | null;
  /** Stable id used to pick a background colour for the initials. */
  seed?: string;
  size?: number;
  online?: boolean;
}

function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

const Avatar = ({ name, src, seed, size = 40, online }: Props) => (
  <div className="relative shrink-0" style={{ width: size, height: size }}>
    {src ? (
      <img src={src} alt="" className="size-full rounded-full border border-base-300 object-cover" />
    ) : (
      <div
        aria-hidden
        className="flex size-full select-none items-center justify-center rounded-full font-semibold text-white"
        style={{ background: `hsl(${hue(seed ?? name)} 55% 45%)`, fontSize: size * 0.38 }}
      >
        {initials(name)}
      </div>
    )}
    {online && <span title="Online" className="absolute bottom-0 right-0 size-3 rounded-full bg-success ring-2 ring-base-100" />}
  </div>
);
export default Avatar;
