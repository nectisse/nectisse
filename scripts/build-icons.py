"""Export the approved artwork as a padded macOS PNG and multi-resolution ICNS."""

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "resources" / "icons"
EDGE = 1024
TILE_EDGE = 824
TILE_OFFSET = (EDGE - TILE_EDGE) // 2
CORNER_RADIUS = 185


def rounded_mask(inset: int = 0) -> Image.Image:
    mask = Image.new("L", (TILE_EDGE * 4, TILE_EDGE * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (inset * 4, inset * 4, (TILE_EDGE - inset) * 4 - 1, (TILE_EDGE - inset) * 4 - 1),
        radius=(CORNER_RADIUS - inset) * 4,
        fill=255,
    )
    return mask.resize((TILE_EDGE, TILE_EDGE), Image.Resampling.LANCZOS)


def finish_tile(artwork: Image.Image, mask: Image.Image) -> Image.Image:
    """Light the tile's rim without adding highlights to the central emblem."""
    alpha = artwork.getchannel("A")
    gradient = Image.linear_gradient("L").resize(artwork.size, Image.Resampling.BILINEAR)
    top = gradient.point(lambda value: round(112 * max(0, 1 - value / 165)))
    bottom = gradient.point(lambda value: round(96 * (value / 255) ** 3))
    bevel = ImageChops.subtract(mask, rounded_mask(10)).filter(ImageFilter.GaussianBlur(1.2))
    edge = ImageChops.subtract(mask, rounded_mask(3))
    for color, band, lighting in (
        ((232, 214, 255), bevel, top),
        ((0, 0, 0), bevel, bottom),
        ((240, 225, 255), edge, top),
    ):
        layer = Image.new("RGBA", artwork.size, (*color, 0))
        layer.putalpha(ImageChops.multiply(band, lighting))
        artwork.alpha_composite(layer)
    artwork.putalpha(ImageChops.multiply(alpha, mask))
    return artwork


def main() -> None:
    with Image.open(ICONS / "icon.png") as source:
        if source.size != (EDGE, EDGE):
            raise ValueError("resources/icons/icon.png 必须为 1024 × 1024")
        artwork = source.convert("RGBA").resize(
            (TILE_EDGE, TILE_EDGE), Image.Resampling.LANCZOS
        )

    # Render the rounded mask at 4x so the exported edges remain antialiased.
    artwork = finish_tile(artwork, rounded_mask())

    shadow = Image.new("RGBA", (EDGE, EDGE), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (TILE_OFFSET, TILE_OFFSET + 8, EDGE - TILE_OFFSET - 1, EDGE - TILE_OFFSET + 7),
        radius=CORNER_RADIUS,
        fill=(0, 0, 0, 36),
    )
    icon = shadow.filter(ImageFilter.GaussianBlur(12))
    icon.alpha_composite(artwork, (TILE_OFFSET, TILE_OFFSET))
    icon.save(ICONS / "icon-macos.png")

    staging = ROOT / ".build" / "icons"
    staging.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(suffix=".iconset", dir=staging) as directory:
        iconset = Path(directory)
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                suffix = "@2x" if scale == 2 else ""
                icon.resize((size * scale, size * scale), Image.Resampling.LANCZOS).save(
                    iconset / f"icon_{size}x{size}{suffix}.png"
                )
        subprocess.run(
            ["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o", str(ICONS / "icon.icns")],
            check=True,
        )
    print("已生成 resources/icons/icon-macos.png 与 icon.icns（16–1024 px）")


if __name__ == "__main__":
    main()
