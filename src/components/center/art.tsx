// A house front in Stonington, Connecticut (Carol M. Highsmith Archive, Library of Congress, no known restrictions on publication).
export function Street() {
  return (
    <div aria-hidden className="street">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/art/street-2200.webp" srcSet="/art/street-1400.webp 1400w, /art/street-2200.webp 2200w, /art/street-2876.webp 2876w"
        sizes="(min-width: 1024px) calc(100vw - 280px), 100vw" alt="" />
    </div>
  );
}

const STROKES = ["M4 2.6C3.4 10 4.7 19 3.8 27.4", "M3.6 3C4.5 11 3.2 18 4.3 27", "M4.3 2.2C3.7 9.5 4.9 20 3.6 27.8", "M3.8 2.9C4.7 12 3.3 17 4.1 27.2"];
const SLASHES = ["M-3.5 21.5C6 17 18 10.5 31 4.6", "M-3 23C8 16.4 17 11.8 30.6 5.8"];

export function Tally({ count }: { count: number }) {
  const n = Math.min(count, 40);
  const groups = Array.from({ length: Math.ceil(n / 5) }, (_, g) => Math.min(5, n - g * 5));
  return (
    <span aria-hidden className="tally pen-draw">
      {groups.map((size, g) => (
        <svg key={g} viewBox="0 0 28 30">
          {Array.from({ length: Math.min(size, 4) }, (_, k) => (
            <path key={k} d={STROKES[(g + k) % STROKES.length]} transform={`translate(${k * 6.6})`} pathLength={1}
              style={{ animationDelay: `${(g * 5 + k) * 34}ms` }} />
          ))}
          {size === 5 && <path d={SLASHES[g % SLASHES.length]} pathLength={1} style={{ animationDelay: `${(g * 5 + 4) * 34}ms` }} />}
        </svg>
      ))}
    </span>
  );
}
