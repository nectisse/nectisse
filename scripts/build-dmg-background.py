"""Render the installer artwork with the same lettering and colors as the app."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SCALE = 2
WIDTH, HEIGHT = 720, 500


def font(name: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(name, size * SCALE, index=index)


def main() -> None:
    image = Image.new("RGB", (WIDTH * SCALE, HEIGHT * SCALE), "#faf9f6")
    draw = ImageDraw.Draw(image)

    def text(position, value, face, color):
        draw.text(tuple(round(n * SCALE) for n in position), value, font=face, fill=color)

    script = font("/System/Library/Fonts/Supplemental/SnellRoundhand.ttc", 64)
    sans = "/System/Library/Fonts/Helvetica.ttc"
    chinese = "/System/Library/Fonts/Hiragino Sans GB.ttc"
    text((46, 35), "Nectisse", script, "#684252")
    text((51, 119), "A  P R I V A T E  C O L L E C T I O N", font(sans, 10), "#806b78")

    # Geometric arcs echo the paired shapes in the app icon.
    for box, color, width in [((540, -82, 770, 148), "#d7c6e4", 22), ((586, -58, 816, 172), "#efcfc6", 18)]:
        draw.arc(tuple(n * SCALE for n in box), 45, 300, fill=color, width=width * SCALE)
    draw.line((48 * SCALE, 164 * SCALE, 672 * SCALE, 164 * SCALE), fill="#e7e2dd", width=SCALE)

    draw.line((307 * SCALE, 269 * SCALE, 411 * SCALE, 269 * SCALE), fill="#927080", width=3 * SCALE)
    draw.line([(399 * SCALE, 258 * SCALE), (411 * SCALE, 269 * SCALE), (399 * SCALE, 280 * SCALE)], fill="#927080", width=3 * SCALE, joint="curve")

    draw.rectangle((0, 394 * SCALE, WIDTH * SCALE, HEIGHT * SCALE), fill="#30232f")
    text((48, 416), "拖入 Applications 即可安装", font(chinese, 21), "#f0e9e9")
    text((49, 453), "Drag Nectisse into Applications to install.", font(sans, 12), "#ceb1c2")
    destination = ROOT / "resources" / "dmg" / "background.png"
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, optimize=True, dpi=(144, 144))


if __name__ == "__main__":
    main()
