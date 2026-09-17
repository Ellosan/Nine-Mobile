"""
Generate AgentKey's app icons.

No PIL / ImageMagick in this environment, so this writes PNGs directly (zlib +
the PNG chunk format) and anti-aliases by evaluating a signed distance field per
pixel rather than supersampling.

The mark is a terminal prompt -- a chevron and an underscore -- in the app's
accent blue on its background navy.
"""

import math
import os
import struct
import zlib

BG = (0x0B, 0x0F, 0x14)
ACCENT = (0x4C, 0xA6, 0xFF)


def write_png(path, width, height, pixels):
    """pixels: flat bytearray of RGBA rows, length = width*height*4."""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw.extend(pixels[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def seg_distance(px, py, ax, ay, bx, by):
    """Distance from point p to segment ab."""
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    cx, cy = ax + t * vx, ay + t * vy
    return math.hypot(px - cx, py - cy)


def render(size, scale, opaque_bg, rounded=False):
    """
    Draw the mark centred on a `size` x `size` canvas.

    scale     - how large the glyph is relative to the canvas
    opaque_bg - fill the background with BG, else leave it transparent
    rounded   - round the background corners (for the standalone icon)
    """
    px = bytearray(size * size * 4)

    # Glyph geometry in normalised coordinates, centred on the origin.
    thickness = 0.052 * scale
    chevron = [
        (-0.20 * scale, -0.23 * scale, 0.01 * scale, 0.0),
        (0.01 * scale, 0.0, -0.20 * scale, 0.23 * scale),
    ]
    underscore = (0.10 * scale, 0.23 * scale, 0.32 * scale, 0.23 * scale)

    corner_r = 0.22  # normalised, for the rounded background
    aa = float(size)  # edge softness in pixels

    for y in range(size):
        ny = (y + 0.5) / size - 0.5
        row = y * size * 4
        for x in range(size):
            nx = (x + 0.5) / size - 0.5

            # ---- background ----
            if opaque_bg:
                if rounded:
                    # Signed distance to a rounded square.
                    qx = abs(nx) - (0.5 - corner_r)
                    qy = abs(ny) - (0.5 - corner_r)
                    d = (math.hypot(max(qx, 0.0), max(qy, 0.0))
                         + min(max(qx, qy), 0.0) - corner_r)
                    bg_a = max(0.0, min(1.0, 0.5 - d * aa))
                else:
                    bg_a = 1.0
            else:
                bg_a = 0.0

            r = BG[0] * bg_a
            g = BG[1] * bg_a
            b = BG[2] * bg_a
            a = bg_a

            # ---- glyph ----
            d = min(seg_distance(nx, ny, *chevron[0]),
                    seg_distance(nx, ny, *chevron[1]),
                    seg_distance(nx, ny, *underscore)) - thickness
            ga = max(0.0, min(1.0, 0.5 - d * aa))

            if ga > 0.0:
                # Source-over composite of the accent colour.
                r = ACCENT[0] * ga + r * (1.0 - ga)
                g = ACCENT[1] * ga + g * (1.0 - ga)
                b = ACCENT[2] * ga + b * (1.0 - ga)
                a = ga + a * (1.0 - ga)

            i = row + x * 4
            px[i] = int(r + 0.5)
            px[i + 1] = int(g + 0.5)
            px[i + 2] = int(b + 0.5)
            px[i + 3] = int(a * 255 + 0.5)
    return px


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')
    out = os.environ.get('ICON_OUT', out)
    os.makedirs(out, exist_ok=True)

    jobs = [
        # Full-bleed square: Android/Expo apply their own masking.
        ('icon.png', 1024, 1.0, True, False),
        # Adaptive foreground: glyph must sit inside the 66% safe zone.
        ('adaptive-icon.png', 1024, 0.62, False, False),
        # Splash mark on a transparent background.
        ('splash-icon.png', 512, 0.95, False, False),
        # Favicon-ish, used if the project is ever exported for web.
        ('favicon.png', 64, 1.0, True, True),
    ]

    for name, size, scale, opaque, rounded in jobs:
        px = render(size, scale, opaque, rounded)
        path = os.path.join(out, name)
        write_png(path, size, size, px)
        print(f'{name}: {size}x{size} -> {os.path.getsize(path)} bytes')


if __name__ == '__main__':
    main()
